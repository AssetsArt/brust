# Native loader HTTP status — `notFound()` / `redirect()` + S12 bodyless-request 411 fix

> Spec · 2026-06-02 · brust · closes FRAMEWORK-GAPS **S9** (native loader can't set
> HTTP status → 404-as-200) and **S12** (bodyless DELETE/non-GET → spurious 411).

## Goal

1. **S9** — Give `native: true` route loaders first-class control over HTTP status via two
   sentinels returned from the loader:
   - `notFound(data?)` — render the route's **own** jinja template with the supplied
     context, but emit **HTTP 404**.
   - `redirect(location, status = 302)` — emit a 3xx with a `Location` header and an
     empty body; the template is **not** rendered.
2. **S12** — Make the action-dispatch body handling RFC 7230 §3.3.3 compliant: a request
   with no `Content-Length` and no `Transfer-Encoding` has **no body** (length 0) for
   **every** method, not just GET/HEAD. A bodyless `DELETE` (or `POST`/`PUT`/`PATCH`)
   must no longer return 411.

## Non-goals

- **No generic `setStatus(n)`** from loaders. Only the two sentinels. Arbitrary status
  codes are out of scope (YAGNI; revisit if a real need appears).
- **No React-route loader status changes.** React routes already set status through
  `RouteResponse` / middleware. This spec touches only the native (jinja) path.
- **No global/custom 404 page.** `notFound()` renders the route's own template. A
  framework-level `not-found` page is future work.
- **No smooth in-place SPA handling of verdicts.** During client SPA navigation a
  `notFound`/`redirect` verdict triggers the existing **full-reload fallback** (the
  document path is authoritative for status). Smooth in-place 404/redirect is future work.
- **No post-`next()` middleware status mutation for native routes** (still deferred, per
  the existing comment at `runtime/routes.ts` ~595).
- **No chunked request-body support.** `Transfer-Encoding` present → rejected (411).
- **MCP endpoint (`/_brust/mcp`) 411 unchanged** — JSON-RPC always carries a body.

## High-level architecture

### S9 — three load-bearing pieces

**(a) TS sentinel helpers** — `runtime/routes.ts`, exported via `brustjs/routes` (the
`./routes` subpath maps to `runtime/routes.ts`) and re-exported from `runtime/index.ts`
(`brustjs`) for parity with `Outlet`/`defineRoutes`.

```ts
const BRUST_VERDICT = Symbol.for('brust.nativeVerdict')

export interface NativeVerdict {
  readonly [BRUST_VERDICT]: true
  readonly status: number
  readonly render: boolean                  // notFound → true; redirect → false
  readonly data?: unknown                    // notFound: template context
  readonly headers?: Record<string, string>  // redirect: { Location }
}

export function notFound(data?: unknown): NativeVerdict
export function redirect(location: string, status?: number): NativeVerdict  // default 302
export function isNativeVerdict(x: unknown): x is NativeVerdict
```

- Detection uses the **global** `Symbol.for('brust.nativeVerdict')` as a property key —
  survives cross-bundle/realm boundaries (the island/component bundles are separate
  chunks) and `JSON.stringify` ignores symbol keys, so a verdict can never collide with
  a loader's plain data keys.
- `redirect` default status `302`. The TS parameter type is the union
  `301 | 302 | 303 | 307 | 308` for guidance; no runtime clamping (an out-of-range value
  forced via `as any` flows through unchanged — caller's responsibility).
- `notFound(data)` carries `data` as the template render context (defaults to `{}`).

**(b) Rust status param** — `napi_render_jinja` (`crates/brust/src/lib.rs` ~840) gains a
4th positional param `status: Option<u32>`. The success-branch meta uses
`status.unwrap_or(200)`. Render-failure still emits 500 (unchanged). The SAB-overflow
fallback still emits 500 (unchanged). A positional `Option<u32>` avoids the napi-rs
`#[napi(object)]` camelCase key-drop gotcha. `index.js` / `index.d.ts` regenerate on the
napi build.

**(c) Native-branch wiring** — `runtime/routes.ts`:

- **Document render branch** (`makeRenderer` native path, ~599): after the loader runs,
  `if (isNativeVerdict(data))`:
  - `!data.render` (redirect) → `return packSingleChunkResponse(view, encoder, {
    status: data.status, contentType: 'text/html; charset=utf-8', body: '',
    headers: data.headers })`. No jinja render.
  - `data.render` (notFound) → set `renderStatus = data.status` (404) and
    `data = data.data ?? {}`, then fall through the **normal** island/component-manifest +
    `napiRenderJinja` flow, passing `renderStatus` as the new 4th arg.
  - Normal return → `renderStatus = undefined` → `napiRenderJinja(...)` called with no
    status (Rust defaults to 200). Both the manifest branch (~654) and the plain branch
    (~682) must thread `renderStatus`.
- **SPA navigation branch** (`renderNativeRouteToHtml`, ~950): after the loader,
  `if (isNativeVerdict(data)) throw <verdict-fallback error>`. The existing
  `navigationBranch` try/catch (routes.ts ~886–936) turns the throw into a 500 JSON
  response; the client's non-2xx check (`bootstrap.ts navigate()` ~199) triggers a full
  reload to the same URL, which hits the **document path** and produces the correct
  status. Zero client/bootstrap change.

### S12 — action body classification

`crates/brust/src/server.rs`, action-dispatch branch (~363). Extract a small,
unit-testable pure helper alongside `parse_content_length`:

```rust
enum BodyClass { Empty, Sized(usize), Chunked }
fn classify_request_body(header: &[u8]) -> BodyClass
```

- `Transfer-Encoding` header present → `Chunked` (regardless of CL).
- else `Content-Length` present & parseable → `Sized(n)`.
- else → `Empty`.

Handler logic replaces the current GET/HEAD-only special case:

```rust
match classify_request_body(&buf[..header_end]) {
    BodyClass::Chunked => { error_411; return }   // unsupported — ask for Content-Length
    BodyClass::Sized(n) if n > max => { error_413; return }
    BodyClass::Sized(n) => n,
    BodyClass::Empty => 0,                          // RFC 7230 §3.3.3: no CL + no TE = no body
}
```

The MCP branch (~516) is left unchanged.

## File structure / touch list

| File | Change |
|---|---|
| `runtime/routes.ts` | add `BRUST_VERDICT`, `NativeVerdict`, `notFound`, `redirect`, `isNativeVerdict`; wire document render branch + nav branch |
| `runtime/index.ts` | re-export `notFound`, `redirect`, `isNativeVerdict`, `NativeVerdict` |
| `crates/brust/src/lib.rs` | `napi_render_jinja` gains `status: Option<u32>`; meta uses `status.unwrap_or(200)` |
| `runtime/index.js` / `index.d.ts` | regenerated by napi build (do not hand-edit) |
| `crates/brust/src/server.rs` | `classify_request_body` helper + action-branch rewrite; unit tests |
| `example/pokedex/lib/loaders.ts` | dogfood: detail 404 path `return notFound({...})` |
| `example/pokedex/FRAMEWORK-GAPS.md` | mark S9 + S12 FIXED |
| tests | see Tests section |

## Behavior invariants

- A native loader's **normal** return is unchanged: rendered template, HTTP 200.
- `notFound(data)` → the **same** template the route would normally render, with `data`
  as context, HTTP **404**. (Render failure inside that template → 500, as today.)
- `redirect(url)` → HTTP 302 (or given 3xx), `Location: url`, empty body, **no** template
  render, **no** loader-data size limit hit (no SAB data write for the body).
- The island/component manifest enrichment runs for `notFound` (it renders a template)
  but is **skipped** for `redirect` (no render).
- S12: identical bytes-on-the-wire for requests that *do* send `Content-Length`. Only the
  missing-CL, non-GET/HEAD case changes (411 → treated as empty body). `Transfer-Encoding`
  present is newly rejected with 411 (previously `parse_content_length` returned `None`
  → 411 for non-GET anyway, so no regression; GET+TE previously → 0, now → 411, which is
  correct since we don't read the chunked body).

## Tests

**Rust unit (`crates/brust/src/server.rs`):**
- `classify_request_body`: missing CL + no TE → `Empty`; `Content-Length: 7` → `Sized(7)`;
  `Transfer-Encoding: chunked` → `Chunked`; CL + TE → `Chunked` (TE wins); case-insensitive
  header names.

**Rust (`crates/brust/src/lib.rs` or jinja):**
- If feasible without a live worker/SAB, a focused test that the meta carries the passed
  status; otherwise covered by the TS integration below (document the choice in the plan).

**TS unit (`runtime/routes.test.ts` or a new `runtime/native-verdict.test.ts`):**
- `notFound()` → `{ status: 404, render: true, data: {} }` + `isNativeVerdict` true.
- `notFound(d)` carries `d`.
- `redirect('/x')` → `{ status: 302, render: false, headers: { Location: '/x' } }`.
- `redirect('/x', 301)` → status 301.
- `isNativeVerdict` false for plain objects / null / loader data.
- Plain object with a `status` key is **not** mistaken for a verdict (symbol-keyed guard).

**Integration (extend `tests/integration.test.ts` or `tests/native-island-ssr.test.ts`
with a fixture native route in `tests/fixtures/app`):**
- GET a native route whose loader returns `notFound({...})` → **HTTP 404** + body contains
  the rendered template markup.
- GET a native route whose loader returns `redirect('/somewhere')` → **HTTP 302** +
  `Location: /somewhere` + empty body.
- A normal native route still → **HTTP 200**.

**Integration S12 (`runtime/action-dispatch.test.ts` or `tests/integration.test.ts`):**
- `DELETE` action with **no body** → **200** (was 411).
- `DELETE` action with `{}` body → **200** (unchanged).
- A request with `Transfer-Encoding: chunked` to an action → **411**.

## Acceptance criteria

- [ ] `notFound(data)` from a native loader → HTTP 404 with the route's rendered template.
- [ ] `redirect(url)` from a native loader → HTTP 302 + `Location` header + empty body.
- [ ] Normal native loader → HTTP 200 (no regression).
- [ ] Bodyless `DELETE`/`POST`/`PUT`/`PATCH` action → 200, not 411.
- [ ] `Transfer-Encoding: chunked` action request → 411.
- [ ] `notFound`/`redirect` exported from `brustjs/routes` and `brustjs`.
- [ ] pokedex detail 404 path uses `notFound()` (dogfood); `/pokemon/<bad>` → HTTP 404.
- [ ] All baselines green: `cargo build/test --workspace --locked`,
      `cargo fmt --check`, `cargo clippy --all-targets --locked -D warnings`,
      `bun run ci` (biome), `bun test runtime/`, and the
      `native-island` / `native-island-ssr` / `cli-new` / `integration` suites.
- [ ] Rebuild `runtime/*.node` (`cd runtime && bun run build`) after the Rust change —
      stale `.node` silently uses the old binary.
- [ ] FRAMEWORK-GAPS.md S9 + S12 → ✅ FIXED.

## Known limitations (shipped)

- SPA navigation to a `notFound`/`redirect` route does a **full reload** (not in-place
  swap). Correct status, slightly less smooth. Future: in-place handling in
  `bootstrap.ts`.
- `notFound()` renders the route's own template; there is no framework-level shared 404
  page yet.
- Only `notFound` / `redirect` sentinels — no arbitrary loader status.

## Open questions resolved at plan-time

- **Where to put the TS verdict unit tests** — new `runtime/native-verdict.test.ts` vs
  extending `runtime/routes.test.ts`. Plan picks one.
- **Whether a focused Rust test for the status param is feasible** without a live worker —
  plan decides; integration covers it regardless.
- **Exact fixture route** for the integration tests in `tests/fixtures/app` — plan
  specifies the file.
