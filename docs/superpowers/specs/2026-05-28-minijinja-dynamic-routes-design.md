# Spec — Dynamic routes via minijinja + JS-loader-over-SAB

**Date:** 2026-05-28
**Branch:** `refactor/cargo-workspace`
**Parent:** `af5a4b8` (A2.3 cleanup) + uncommitted minijinja bench (HEAD wd)
**Replaces:** Path A (A1 jsx-rust-compiler → A2.0–A2.3 maud-static). Those landed but are now superseded.

---

## 0. Why this exists

User direction after benching A2.3's static-only path + my minijinja smoke test:

| Path | RPS (M1 Pro, oha -c 120 -z 10s) |
|---|---:|
| `/ping` (5-byte literal) | 109,788 |
| `/_rust-static` A2.3 (pre-baked maud Vec) | 112,821 |
| **`/_jinja-test/World` (minijinja OnceLock + per-req context)** | **101,430** |
| `/` (React `renderToPipeableStream`) | 26,871 |

minijinja is **3.8× faster than React** while accepting arbitrary data — loader-friendly, prop-friendly, **not** stuck on a static fixture. The maud + jsx-rust-compiler chain is therefore over-engineered for the goal: a constrained compile-time DSL that only handles the no-data subset. minijinja covers both static AND dynamic with a single, runtime, well-maintained engine.

This spec pivots from "compile JSX to Rust" to "compile project-wide jinja templates at brust build time + JS loader feeds data via SAB". The architectural insight from A2.3 (Rust short-circuit BEFORE tsfn dispatch) is preserved; the engine swaps from maud to minijinja.

## 1. Goal

Replace A1 + A2.x with a single dynamic-route path:

```tsx
{ path: '/profile/{user}', Component: ProfilePage, jinja: true,
  loader: async ({ params }) => ({ user: params.user, joinedAt: '2024-01-01' }) }
```

The framework:
1. At brust build time, registers `ProfilePage` (Component.name) → `.jinja` template (committed in brust source tree).
2. At request time:
   - Rust matches route
   - JS worker runs middleware + loader → produces a `data` object
   - JS writes JSON-serialized `data` into the shared buffer (SAB), calls `napiRenderJinja(workerId, dataLen, templateName)` (parallel to existing `napiRenderChunkFinal`).
   - Rust reads `data` from SAB, looks up the template, calls `Environment::get_template(name).render(data)` → HTML String, frames response, writes to TCP.
3. Per-request perf claim: within noise of `/ping` (~100k+ RPS), bound by SAB write + minijinja render (~10µs).

## 2. Non-goals (and what gets DELETED)

| Item | Action |
|---|---|
| `crates/jsx-rust-compiler/` (whole crate) | **KEEP** — standalone tooling, no longer in brust build pipeline. Useful for future JSX→other-target work. |
| `crates/brust/src/compiled_routes/` (mod + .tsx) | **DELETE** — replaced by `crates/brust/src/jinja_routes/*.jinja` |
| `crates/brust/Cargo.toml`: `maud = "0.27"` | **DELETE** — minijinja replaces maud as the Rust-side template engine |
| `crates/brust/Cargo.toml`: `jsx-rust-compiler` build-dep | **DELETE** — brust no longer compiles .tsx at build time |
| `crates/brust/build.rs`: tsx-scanning block | **REPLACE** with jinja-scanning block (committed file → static `include_str!` into registry) |
| `crates/brust/src/lib.rs`: `napi_render_compiled` function | **DELETE** — replaced by `napi_render_jinja` (SAB-based, no String args) |
| `crates/brust/src/routes.rs`: `RouteConfig.static_render` + `RouteTable.static_renders` + `static_prebuilt` | **DELETE** — replaced by `dynamic_template` + per-route template-name lookup |
| `crates/brust/src/server.rs`: A2.3 short-circuit branch | **DELETE** — the new dispatch ALWAYS goes through worker (loader runs there) |
| `runtime/routes.ts`: `static?: boolean` + `staticRender` + related validation | **DELETE** — replaced by `jinja?: boolean` + `jinjaTemplate` |
| `runtime/index.ts`: `registerRoutes` payload's `staticRender` | **REPLACE** with `jinjaTemplate` |
| `tests/napi-render-compiled.test.ts` | **DELETE** — napi shim retired |
| `tests/rust-compiled-route.test.ts` | **REPLACE** with `tests/jinja-route.test.ts` (dynamic data + URL param via loader) |
| `crates/brust/src/dynamic_routes.rs` (uncommitted bench) | **PROMOTE** to first-class — base for the new architecture |
| Example app, test fixtures | **MIGRATE** to new `jinja: true` shape with a real loader |
| `architecture.md` Sub-project A1 + A1.1 section | **REWRITE** as Sub-project J (jinja-dynamic), document numbers + that the maud chain was a stepping stone |

The cleanup is a single commit so reverting is mechanical. **No silent feature loss**: the static use case (no data) becomes "jinja route with empty loader" — still beats /ping by a noise margin since the template is render-once via minijinja's compile cache.

## 3. High-level architecture

```
TCP → Rust accept → match_path → route_id
                                   ↓
                       dispatch_to_worker (tsfn)
                                   ↓
                   ┌──── JS worker (existing) ────┐
                   │                              │
                   │  middleware chain → loader   │
                   │  → data object               │
                   │                              │
                   │  JSON.stringify(data)        │
                   │  → write to SAB[0..len]      │
                   │  → napiRenderJinja(          │
                   │       workerId, len,         │
                   │       templateName)          │
                   └──────────────────────────────┘
                                   ↓ (napi)
                            Rust render path:
                       1. Read SAB[0..len] as &[u8]
                       2. serde_json::from_slice → Value
                       3. JINJA_ENV.get_template(name)
                       4. .render(value) → String
                       5. http::build_response(200, html)
                       6. write_all(bytes) → TCP
```

The architectural shape mirrors how `actions` ship JSON over SAB today: SAB is reused, only the napi callback is different. No new IPC primitive.

## 4. Crate layout changes

```
crates/brust/
├── Cargo.toml                  # -maud, -jsx-rust-compiler (build-dep), +minijinja
├── build.rs                    # scan jinja_routes/*.jinja, emit include_str!() registry
├── src/
│   ├── compiled_routes/        # DELETE
│   ├── dynamic_routes.rs       # DELETE (bench-only; promoted into jinja module)
│   ├── jinja_routes/           # NEW — committed .jinja templates
│   │   ├── HelloPage.jinja
│   │   └── ProfilePage.jinja
│   ├── jinja.rs                # NEW — Environment + register_template + render_by_name
│   └── lib.rs                  # -napi_render_compiled +napi_render_jinja
```

`crates/jsx-rust-compiler/` stays untouched as standalone tooling — no longer a build-dep of brust. Future use (e.g. an A4 dialect expansion or hand-written maud comparison) remains possible.

## 5. JS API

```ts
// runtime/routes.ts
interface Route {
  path?: string
  Component?: ComponentType<any>
  loader?: (...) => Promise<unknown>
  /** Dynamic Rust-rendered route via minijinja. Component.name is the
   * registry key — must match a `.jinja` file's basename committed in
   * `crates/brust/src/jinja_routes/`. The framework runs middleware +
   * loader on the JS worker, serializes the result as JSON, ships it to
   * Rust via the shared buffer (parallel to actions), and Rust renders
   * the template with that JSON as the root context. */
  jinja?: boolean
  middleware?: Middleware[]
  // ... existing fields
}
```

Validation (`validateRoute`):
- `jinja: true` requires `Component` and `Component.name` non-empty.
- `jinja: true` allows `loader` (this is the whole point — loader feeds data).
- `jinja: true` allows `middleware`.
- `jinja: true` rejects `sse`, `websocket`, `children`, `cache` (cache work is deferred to a follow-up).

`FlatRoute.jinjaTemplate?: string` = `leaf.Component.name` when `leaf.jinja === true`. Shipped to Rust as `jinjaTemplate` field in `RouteConfig`.

## 6. Rust API

```rust
// crates/brust/src/jinja.rs
use std::sync::OnceLock;
use minijinja::Environment;

static ENV: OnceLock<Environment<'static>> = OnceLock::new();

/// Returns a static Environment with all jinja_routes/*.jinja registered.
/// build.rs emits a `JINJA_TEMPLATES: &[(name, source)]` table; we add each
/// at first init. Add-template failures panic (templates are static, errors
/// would be developer-time bugs).
pub fn env() -> &'static Environment<'static> {
    ENV.get_or_init(|| {
        let mut e = Environment::new();
        for (name, source) in jinja_routes::JINJA_TEMPLATES {
            e.add_template(name, source)
                .unwrap_or_else(|err| panic!("jinja template {name} failed to parse: {err}"));
        }
        e
    })
}

/// `data_json` is a UTF-8 slice serde_json::from_slice's into a Value, then
/// rendered into a String. Returns Err on JSON parse failure, template
/// lookup miss, or render error — caller maps each to an HTTP status.
pub fn render(name: &str, data_json: &[u8]) -> Result<String, RenderError> {
    let env = env();
    let tmpl = env.get_template(name).map_err(|_| RenderError::UnknownTemplate)?;
    let value: serde_json::Value = serde_json::from_slice(data_json)
        .map_err(|e| RenderError::BadJson(e.to_string()))?;
    tmpl.render(value).map_err(|e| RenderError::Render(e.to_string()))
}

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("unknown template")] UnknownTemplate,
    #[error("bad JSON: {0}")] BadJson(String),
    #[error("render: {0}")] Render(String),
}
```

`build.rs` change (replaces compiled_routes scan):

```rust
// scan crates/brust/src/jinja_routes/*.jinja
// emit $OUT_DIR/jinja_templates.rs:
//   pub static JINJA_TEMPLATES: &[(&str, &str)] = &[
//       ("HelloPage", include_str!(".../jinja_routes/HelloPage.jinja")),
//       ...
//   ];
// `src/jinja_routes/mod.rs` does `include!(concat!(env!("OUT_DIR"), "/jinja_templates.rs"));`
```

`cargo:rerun-if-changed=src/jinja_routes` ensures edits to a template trigger rebuild.

## 7. SAB protocol — loader data inbound

Each worker already owns a registered SAB buffer (`BufPtr` + `len` registered at `register_renderer`). The existing protocol for HTML chunks is `[len: u32 LE][body bytes]` from JS to Rust. For jinja:

| Step | Side | Bytes |
|---|---|---|
| Worker runs loader → `data: unknown` | JS | — |
| `const json = JSON.stringify(data ?? {})` | JS | — |
| `const dataBytes = encoder.encode(json)` | JS | — |
| `if (dataBytes.length > sabLen) ERROR` (413 path) | JS | — |
| `sab.set(dataBytes, 0)` | JS | — |
| `await napiRenderJinja(workerId, dataBytes.length, templateName)` | JS→Rust napi | — |
| Rust: read `&sab[0..len]`, render, write to TCP | Rust | — |

`napi_render_jinja` signature (added in lib.rs):

```rust
#[napi]
pub async fn napi_render_jinja(
    worker_id: u32,
    data_len: u32,
    template_name: String,
) -> NapiResult<()> {
    // Pull the BufPtr for this worker; copy/slice; render; write to socket.
    // Mirrors the existing napi_render_chunk_final dispatch path.
    // ...
}
```

**Important**: this fn does NOT return bytes; it queues the response on the same chunk channel the existing render path uses, so the response framing + TCP write happens in the per-conn task (consistent with all other response paths in brust).

## 8. Server dispatch (server.rs)

The A2.3 short-circuit is gone. The render branch at line 850-style does:

```
match_path → route_id
  ↓
let jinja_template = routes.jinja_template_for(route_id);
let envelope_json = build_render_envelope_with_jinja_marker(jinja_template, ...);
dispatch_to_worker_and_stream_chunks(envelope_json, "render", ...)
```

JS side worker dispatcher reads `envelope.jinjaTemplate` from the envelope. If set: middleware → loader → write data to SAB → napi_render_jinja. Else: middleware → loader → React render (existing path).

That's it. **No new Rust-side dispatch branch.** Loader still runs on JS (so brust's existing loader contract is unchanged); the only new path is data-out-via-SAB instead of HTML-out-via-SAB, and a different napi callback.

## 9. Loader integration

Loader's contract is unchanged: `async ({ params, req }) => DataT`. Return value gets `JSON.stringify`'d. minijinja accepts `serde_json::Value` natively, so any JSON-serializable shape works in templates:

```jinja
{# crates/brust/src/jinja_routes/HelloPage.jinja #}
<div>
  <h1>Hello {{ name }}!</h1>
  {% if joinedAt %}<p>Joined: {{ joinedAt }}</p>{% endif %}
  <ul>{% for item in items %}<li>{{ item.label }}</li>{% endfor %}</ul>
</div>
```

```tsx
{ path: '/hello/{name}', Component: HelloPage, jinja: true,
  loader: async ({ params }) => ({
    name: params.name,
    joinedAt: '2026-05-28',
    items: [{ label: 'Alpha' }, { label: 'Beta' }]
  })
}
```

Reach: any JSON shape, any depth, any iterables, any conditionals — minijinja covers the Jinja2 spec.

## 10. Tests

Unit (`crates/brust/src/jinja.rs #[cfg(test)]`):
- `env_registers_all_templates`
- `render_hit_with_full_context`
- `render_unknown_template_returns_unknown_error`
- `render_bad_json_returns_bad_json_error`

Build (cargo):
- `cargo build -p brust` — must succeed; `JINJA_TEMPLATES` table is generated.

Integration (Bun):
- `tests/jinja-route.test.ts` — start brust example app with a `jinja: true` route + a loader returning params + a fixed string; curl, assert response includes both.
- Existing `serves rendered html` (React path) unchanged.

Workspace:
- 110 brust + 36 jsx-rust-compiler unit tests still green.
- 196 bun runtime tests minus 6 (A2.3 validation now jinja validation = -6 + 6 = 196, same count).

## 11. Acceptance criteria

1. `cargo build --workspace` succeeds.
2. `cargo test --workspace --lib` passes (counts re-verified, no decrease).
3. `bun run build` succeeds (napi cdylib rebuilds with `napi_render_jinja` exported).
4. `bun test runtime/` ≥ 190 pass (existing + new jinja validation tests).
5. `bun test tests/jinja-route.test.ts` passes — proves dynamic-data end-to-end.
6. `bun test tests/integration.test.ts -t 'serves rendered html'` passes (React unchanged).
7. `oha -c 120 -z 10s -m GET /_jinja-test/World` ≥ 90,000 RPS — proves performance carried over from the smoke bench.
8. `cargo clippy -p brust --lib -- -D warnings` clean.
9. No references to `static: true`, `staticRender`, `rustCompiled`, `napiRenderCompiled`, `compiled_routes`, or `maud` remain in any tracked file (verified by `grep -rn`).

## 12. Known limitations (shipped state)

- Templates committed in brust source tree (`crates/brust/src/jinja_routes/`). End users adding their own templates is **deferred** — same gap as A2.3 (per-app workspace template / cdylib rebuild required).
- Cache integration (LRU per route) deferred — `cache` field rejected when `jinja: true`. Follow-up adds it.
- `Component` prop is just a name marker; the JSX is never executed. Users can write `export default function HelloPage() { throw new Error('jinja-only') }` to make the misuse loud — or just leave a no-op return. Documentation will recommend a no-op.
- Single-process minijinja Environment — no per-route hot-reload during dev (`brust dev`). Template edits require a rebuild. Future: optional jinja file watcher that reloads `Environment` (defaults off for prod).
- minijinja's render allocates a `String`. Per-request allocator pressure is higher than A2.3's Arc-clone-bytes path. Bench gap was 8% in the smoke; acceptable trade.
- SAB size cap (currently per-worker `len`): if `JSON.stringify(data)` exceeds the SAB, the worker emits a 413. Future: switch large data to a Buffer-arg napi fallback or grow SAB.

## 13. Open questions resolved at plan-time

1. **Field name: `jinja: true` vs `dynamic: true` vs `template: 'name'`?** Going `jinja: true` for clarity + parallel to `static: true`. Alternative `template: 'name'` is more flexible (string-keyed, future engines) but loses the brevity. Reviewer should flag if `dynamic: true` is preferred.
2. **Template name source: `Component.name` vs explicit `jinja: 'TemplateName'`?** Using `Component.name` for parity with A2.3's `static: true` convention. Trade-off: requires named function. Alternative: drop Component requirement, take string name in `jinja: 'name'`. Reviewer to flag.
3. **Where does Component get rendered, if anywhere?** Nowhere on the server. Spec says "Component is name-only". This may surprise React refugees. Alternative: render React on hydration only (islands path). For A2.x scope, stay name-only.
4. **JSON shape on SAB**: raw JSON-stringified loader return, or a wrapper envelope (`{ template: '...', data: ... }`)? Going raw — the template name is the napi arg, not in the envelope. Saves one parse step.
5. **What happens when loader returns nothing/undefined?** JS-side ships `"{}"` (empty object). Rust renders with empty context. Templates can use `{% if user is defined %}` to guard. Reviewer to flag.
6. **Error path semantics**: 
   - `RenderError::UnknownTemplate` → 500 (developer-time config drift)
   - `RenderError::BadJson` → 500 (loader bug; never user input)
   - `RenderError::Render` → 500 (template bug)
   All map to a generic 500 page. Future: dev-mode shows error details.
7. **Cleanup commit shape**: single all-or-nothing commit, OR two-phase (delete-old, add-new)? Going single-commit for atomicity: revert = revert one. Reviewer to flag.

## 14. Migration: how does A1+A2.x land cleanly become this?

Step-by-step (executed in plan):
1. `git rm` A2 files: `crates/brust/src/compiled_routes/`, `tests/napi-render-compiled.test.ts`, `tests/rust-compiled-route.test.ts`.
2. Edit `crates/brust/Cargo.toml`: remove `maud`, remove `jsx-rust-compiler` build-dep, add `minijinja = "2"`.
3. Edit `crates/brust/build.rs`: replace tsx scan with jinja scan.
4. Add `crates/brust/src/jinja_routes/HelloPage.jinja` + (optionally) more.
5. Add `crates/brust/src/jinja.rs` + `crates/brust/src/jinja_routes/mod.rs`.
6. Edit `crates/brust/src/lib.rs`: `-mod compiled_routes` `-fn napi_render_compiled` `+mod jinja` `+mod jinja_routes` `+fn napi_render_jinja`.
7. Edit `crates/brust/src/routes.rs`: replace `static_render` + `static_prebuilt` with `jinja_template`.
8. Edit `crates/brust/src/server.rs`: drop A2.3 short-circuit (the Bench-only minijinja hardcoded path also gets dropped or migrated as a test fixture).
9. Edit `runtime/routes.ts`: `static?` → `jinja?`, `staticRender` → `jinjaTemplate`, validation block rewritten.
10. Edit `runtime/routes.test.ts`: 7 validation tests, names/expectations updated.
11. Edit `runtime/index.ts`: `staticRender` → `jinjaTemplate` in `registerRoutes` payload.
12. Edit `runtime/routes.ts` dispatcher: NEW worker-side jinja branch — middleware + loader → SAB write → napi_render_jinja.
13. Edit example/hello-world/routes.tsx + tests/fixtures/app/routes.tsx: migrate `static: true` routes to `jinja: true` + loader.
14. Add `tests/jinja-route.test.ts` (E2E).
15. Update `architecture.md`: rewrite Sub-project A1 + A1.1 section as "Sub-project J — dynamic routes via minijinja", note the maud chain superseded.

`jsx-rust-compiler` crate stays — it's still useful standalone tooling and the spec is committed under `docs/superpowers/specs/`.

## 15. Out of scope (acceptable deferrals)

- Per-app templates (end-user `.jinja` files outside brust source tree)
- Cache integration for jinja routes
- Hot-reload of jinja templates during `brust dev`
- Streaming render (large templates buffered fully in String; switch later)
- Loader-side prop validation (TypeScript types on Component aren't enforced server-side)
- jinja includes / inheritance across templates — works at minijinja level, just not specifically tested in this spec

---

End of spec. Reviewer next.
