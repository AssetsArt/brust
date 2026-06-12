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

`ClientOpts` gains `baseUrl?: string` — absolute origin (`https://api.example.com`), trailing slash stripped. URL building becomes `(baseUrl ?? '') + prefix + '/' + segments.join('/')`. When `baseUrl` is set and `opts.prefix` is NOT, the prefix default stays `/_brust/action` (the global `__BRUST_ACTION_PREFIX__` belongs to the SERVING app, not the remote — do not consult it when baseUrl is set). Existing same-origin behavior byte-identical when `baseUrl` absent. Note in docs: cross-origin cookies require `fetch` init `credentials: 'include'` — expose `init?: RequestInit`-style passthrough ONLY if one already exists (do not add new fetch-option surface in v1; document the existing `fetch` override seam if present — verify in code).

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

Validation at `serve()` boot (fail fast, Rust side mirrors): `origins` non-empty; `credentials && origins == ['*']` → boot error (browsers reject that combination silently — make it loud).

### Rust (`brust-core`)

`CorsConfig` struct in `config.rs`, stored on AppState (set once at boot via the ServeOptions thread-through, like `action_prefix`). Behavior in `server/mod.rs::handle_request`:

1. **Preflight:** `OPTIONS` + `Origin` + `Access-Control-Request-Method` present + cors configured + origin allowed → `204` with: `Access-Control-Allow-Origin` (echo origin, or `*` when configured `*` and no credentials), `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` (config list or echo of `Access-Control-Request-Headers`), `Access-Control-Max-Age`, `Access-Control-Allow-Credentials` (when configured), `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`. Runs BEFORE the method gate (which currently 405s OPTIONS). `OPTIONS` without preflight headers, or disallowed origin, or no cors config → existing behavior (405) unchanged.
2. **Actual responses:** when cors configured and request has an allowed `Origin`: insert `Access-Control-Allow-Origin` (+ `Allow-Credentials`, `Expose-Headers`, `Vary: Origin`) on the response — at the same layer that stamps `X-Powered-By` (~line 261, insert-if-absent so user middleware wins) and on the streaming/chunked path (`chunked_response_from_meta`) — verify both response-assembly sites get the headers (single helper).

Origin matching: exact string match against the configured list (scheme+host+port); `*` matches all. No wildcard subdomains in v1 (documented).

## File structure

- `runtime/treaty.ts` + `runtime/treaty.test.ts` — baseUrl
- `runtime/index.ts` — ServeOptions.cors type + boot validation + pass-through
- `crates/brust/src/lib.rs` — NapiCorsOptions object + validation + thread to brust-core
- `crates/brust-core/src/config.rs` — CorsConfig + AppState field + setter
- `crates/brust-core/src/server/mod.rs` — preflight branch + response-header helper (both assembly paths)
- `tests/cors.integration.test.ts` — new (boot fixture app WITH cors via its entry opts? — fixture entry reads env to enable cors so the shared fixture stays unchanged for other suites; verify how fixture passes opts and pick the least invasive switch, e.g. `BRUST_TEST_CORS=1` branch in fixture index.ts)
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
