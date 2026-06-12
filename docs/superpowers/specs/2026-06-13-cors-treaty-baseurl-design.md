# CORS + treaty cross-origin baseUrl — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R5 — `client<Actions>()` can only hit same-origin `/_brust/action`; brust has no CORS config. Blocks splitting `apps/api` (actions + MCP + AI loop) into its own deployment.

## Goal

1. **treaty `baseUrl`:** `client<Actions>({ baseUrl: 'https://api.example.com' })` targets another origin (combined with the existing `prefix`).
2. **Server CORS:** opt-in `cors` config — preflight (`OPTIONS`) handling + `Access-Control-*` response headers in the hyper server, so browsers allow those cross-origin calls.

## Non-goals

- Per-route CORS policies (one global config; the consumer's api deployment is all-actions).
- Private Network Access headers, CORP/COEP — out of scope.
- Cookie/session design guidance beyond passing `credentials` through.

## API surface

### TS treaty (`runtime/treaty.ts`)

`ClientOptions` (existing type, lines 12-16) gains `baseUrl?: string` — absolute origin (`https://api.example.com`; path suffix like `/v2` composes by concatenation), validated `/^https?:\/\//`, trailing slash stripped. URL building becomes `(baseUrl ?? '') + prefix + '/' + segments.join('/')`. When `baseUrl` is set: prefix = `opts.prefix ?? '/_brust/action'` — the global `__BRUST_ACTION_PREFIX__` belongs to the SERVING app, never consulted under baseUrl. Existing same-origin behavior byte-identical when `baseUrl` absent. Cross-origin cookies: the existing `ClientOptions.fetch` override seam (line 15, `doFetch = opts?.fetch ?? fetch`) is the documented escape hatch for `credentials: 'include'` — NO new RequestInit surface in v1. Tests drive through the same `fetch` seam all 7 existing treaty tests already use.

### Server config

`ServeOptions.cors` (TS `runtime/index.ts` + NAPI `#[napi(object)]` in `crates/brust/src/lib.rs` — **napi camelCases fields; TS sends camelCase**):

```ts
cors?: {
  /** Allowed origins. ['*'] = any origin (echoed as literal '*'). */
  origins: string[]
  /** Preflight Access-Control-Allow-Methods. Default: GET,POST,PUT,PATCH,DELETE,OPTIONS */
  methods?: string[]
  /** Preflight Access-Control-Allow-Headers. Default: echo Access-Control-Request-Headers. */
  headers?: string[]
  /** Access-Control-Expose-Headers on actual responses. Default: none. */
  exposeHeaders?: string[]
  /** Access-Control-Allow-Credentials: true. INVALID with origins ['*'] — serve() throws at boot. */
  credentials?: boolean
  /** Access-Control-Max-Age seconds. Default 600. */
  maxAgeSeconds?: number
}
```

Validation at `serve()` boot (fail fast, Rust side mirrors): `origins` non-empty; a list **containing** `'*'` is treated as wildcard (so `['*', 'https://x.com']` can't dodge the check); `credentials && wildcard` → boot error (browsers reject that combination silently — make it loud).

### Rust (`brust-core`)

`CorsConfig` struct in `config.rs`, stored on AppState (set once at boot via the ServeOptions thread-through, like `action_prefix`). Behavior in `server/mod.rs::handle_request`:

1. **Preflight:** `OPTIONS` + `Origin` + `Access-Control-Request-Method` present + cors configured + origin allowed → `204` with: `Access-Control-Allow-Origin` (echo origin, or `*` when wildcard and no credentials), `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` (config list or echo of `Access-Control-Request-Headers`), `Access-Control-Max-Age`, `Access-Control-Allow-Credentials` (when configured), `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`. Runs BEFORE the method gate (~line 444). NOTE: OPTIONS under the action prefix currently passes the gate (`under_actions`) and 405s later in `handle_action` (`Method::from_http` ~803-806) — the unchanged-fallback tests must cover BOTH 405 sources. `OPTIONS` without preflight headers, or disallowed origin, or no cors config → existing behavior (405) unchanged.
2. **Actual responses — SINGLE CHOKEPOINT:** stamp at the `service_fn` closure (~lines 259-264, where X-Powered-By is stamped) — that closure sees EVERY response path: static assets, all error helpers, L1 cache-hit framed bytes, all `response_from_meta` variants, chunked/streaming, SSE/WS rejections and upgrades. Do NOT also stamp in `chunked_response_from_meta`, and NEVER inside `response_from_meta`/dispatch — the L1 cache captures framed bytes pre-stamp, so stamping inside dispatch would bake a per-request echoed Origin into a SHARED cache entry (cache poisoning across origins). The closure must clone the `Origin` header value BEFORE `req` is moved into `handle_request`.
   - `Access-Control-Allow-Origin` / `Allow-Credentials` / `Expose-Headers`: insert-if-absent (user middleware wins, X-Powered-By precedent), only when the request's Origin is allowed.
   - **`Vary`: APPEND (comma-join), never insert-if-absent** — `static_asset_response` already emits `Vary: Accept-Encoding` and or_insert would silently drop the Origin variance → CDN cache poisoning. And when cors is configured with non-`*` origins, append `Vary: Origin` on EVERY response, even those without an Origin header — otherwise an intermediary caches the no-ACAO variant and replays it cross-origin.
   - Resolve `CorsConfig` once pre-accept-loop into prebuilt `HeaderValue`s (mirror the `powered_by` resolution ~188-197); `set_cors` boot-only setter mirrors `set_tls`/`set_generator`.

Origin matching: exact string match against the configured list (scheme+host+port); `*` matches all. No wildcard subdomains in v1 (documented).

## File structure

- `runtime/treaty.ts` + `runtime/treaty.test.ts` — baseUrl
- `runtime/index.ts` — ServeOptions.cors type + boot validation + pass-through
- `crates/brust/src/lib.rs` — NapiCorsOptions object + validation + thread to brust-core
- `crates/brust-core/src/config.rs` — CorsConfig + AppState field + setter
- `crates/brust-core/src/server/mod.rs` — preflight branch + response-header helper (both assembly paths)
- `tests/cors.integration.test.ts` — new, OWN file/process (combined fixture suites have a known port-race flake). Fixture switch: env branch in `tests/fixtures/app/index.ts` (`cors: process.env.BRUST_TEST_CORS ? {...} : undefined`) — exact house pattern (`BRUST_ACTION_PREFIX` precedent in the same file)
- docs: actions docs page — "Cross-origin actions" section (baseUrl + cors config + credentials note)

## Behavior invariants

1. No cors config → byte-identical behavior (no new headers, OPTIONS still 405).
2. Preflight never reaches the worker/render pipeline (answered in Rust, fast).
3. User-middleware-set headers win over CORS headers (insert-if-absent, same as X-Powered-By).
4. Disallowed origin: no ACAO header on response (browser blocks), request otherwise processed normally (server is not the enforcement point for non-preflight).
5. `credentials` never combined with literal `*` (boot-validated both sides).
6. treaty with `baseUrl` never reads `__BRUST_ACTION_PREFIX__`.

## Tests

- TS unit (treaty.test.ts — there is an existing injected-fetch seam; verify): baseUrl + default prefix URL; baseUrl + custom prefix; trailing-slash normalization; no-baseUrl path unchanged (does not consult global when set / consults when absent).
- Rust unit: origin matching (exact, `*`, miss), preflight header assembly, credentials+`*` validation error.
- Integration (`tests/cors.integration.test.ts`): fixture booted with cors `{origins:['http://allowed.test'], credentials:true}`:
  - OPTIONS preflight to `/_brust/action/...` with Origin+ACRM → 204 + all headers correct
  - actual POST action with allowed Origin → response carries ACAO=origin + credentials true + Vary
  - disallowed Origin → no ACAO; preflight from disallowed origin → 405 fallback
  - page route GET with allowed Origin → ACAO present (global policy)
  - no-cors boot (existing integration suite) — OPTIONS still 405 (already covered by existing tests if any; add explicit)
- Boot validation: serve with credentials+`*` → throws (TS test).

## Acceptance criteria

cargo + bun suites green (known pre-existing fail exempt), clippy/fmt/biome clean, addon rebuilt, docs section added.

## Known limitations

- No per-route policy, no wildcard subdomain matching (exact origins or `*`).
- `Access-Control-Allow-Origin` applies globally (pages too) when configured — acceptable for the api-deployment use case; documented.
