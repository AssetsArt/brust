# Middleware params/locals + loader arbitrary status — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R6 + R7. R6: middleware is `(req, next) => RouteResponse | next()` — can't see parsed params, can't pass data to loaders/handlers (their draft-auth middleware regex-parses the raw URL and the loader re-verifies — two paths that must stay in sync; was a security finding). R7: loaders can only throw `notFound()` (404) / `redirect()` (3xx); anything else becomes a 500 — 403 has to be done in middleware today.

## Goal

1. **R6:** middleware sees the matched route `params` and can attach request-scoped data (`locals`) that loaders/handlers read.
2. **R7:** loaders can throw `httpError(status, body?)` to short-circuit with any status.

## Non-goals

- Typed locals (generic Middleware<TLocals>) — `Record<string, unknown>` in v1.
- httpError rendering a styled error page / catch-all (it is a short-circuit response like a middleware rejection; rendering error LAYOUTS per status is a separate feature).
- Action-handler status (already covered by `ActionError`).
- Changing middleware ordering or the composeChain contract.

## Design

### R6 — `req.params` + `req.locals`

`BrustRequest` (runtime/routes.ts ~89-101) gains:

```ts
/** Matched route params (decoded), available to middleware and everything
 * downstream. Empty object for routes without params. */
params: Record<string, string>
/** Request-scoped bag middleware can write and loaders/handlers read.
 * Same object identity across the whole chain. */
locals: Record<string, unknown>
```

Population: at every site that constructs the `BrustRequest` handed to `composeChain` — render path (~933), action dispatch (~2154), SPA nav (~1491), SSE (~2276), WS (~2382) — set `params` from the already-matched RouteCall/envelope params (actions: the action router's matched params) and `locals: {}`. The SAME `req` object flows into loader ctx (`{ params, path, req }`) and action handler ctx — loaders read `req.locals`; nothing new to thread. Both fields are non-optional on the type but population must be verified at ALL construction sites (grep every `BrustRequest`-shaped literal; a missed site = runtime undefined — add a test per path).

Middleware type signature unchanged (`(req, next)`) — the new data rides on `req`. Backward compatible: existing middleware ignores the new fields; existing tests unchanged.

### R7 — `httpError(status, body?, opts?)`

New throwable, mirroring the `notFound`/`redirect` NativeVerdict pattern (routes.ts ~226-275) but as its own symbol-keyed type (it must work in BOTH native and React loader paths):

```ts
export interface HttpErrorOpts { contentType?: string; headers?: Record<string, string> }
/** Throw from a loader to short-circuit the response with an arbitrary
 * status. `body`: string → text/plain (or opts.contentType); object → JSON.
 * Status must be 400-599 (3xx is redirect()'s job, 404-with-page is
 * notFound()'s). */
export function httpError(status: number, body?: string | object, opts?: HttpErrorOpts): never
```

`httpError` THROWS the trigger itself (like `notFound()` returns a verdict the loader throws? — CHECK actual notFound usage: native loaders `return notFound()`/`throw`? The S9 sentinel returns a verdict; React `notFound()` is thrown via trigger. For httpError: always THROW — `: never` signature, the function throws internally; consistent single usage form in docs).

Catch sites (all four loader paths):
1. **Native** (runNativeChainLoaders catch ~1066 + verdict handling ~1077): recognize `isHttpErrorTrigger(err)` → fast-lane response `{status, body, contentType}` (same mechanism as the middleware short-circuit / 500 path). Headers applied.
2. **React render** (buildRenderElement catch ~1248, where isNotFoundTrigger is handled): httpError → short-circuit RouteResponse with status/body — NOT the errorBoundary path.
3. **SPA nav** (`/_brust/page` ~1437-1509): httpError → respond with the status + JSON body `{ error: true, status }` (or the provided body) so the client navigation surfaces the failure; verify how notFound is signaled on this path and mirror the shape.
4. **Unknown throws** keep becoming 500 (unchanged).

Status validation: integer 400-599, else the trigger constructor throws a plain Error immediately (programming error, loud).

## File structure

- `runtime/routes.ts` — BrustRequest fields, httpError + trigger + guard, 4 catch sites, req construction sites
- `runtime/http-error.test.ts` or extend `runtime/routes.test.ts` (follow existing unit-test layout)
- `tests/fixtures/app` — routes: `/locals-demo` (middleware writes `req.locals.user` from `req.params` + cookie, loader returns it, page renders it), `/forbidden` (loader throws `httpError(403, 'no entry')`), native variant `/_test/native-forbidden/{user}` (native loader throws httpError(403)), middleware-params route asserting `req.params` visible in middleware (middleware short-circuits 412 when `params.id === 'blocked'`)
- `tests/integration.test.ts` — assertions for the above incl. SPA-nav status propagation (`x-brust-nav` style request? check how nav requests are made — mirror an existing SPA-nav test)
- docs: middleware + loader docs pages — params/locals section + httpError section

## Behavior invariants

1. `req` object identity is preserved middleware → loader/handler (locals written before `next()` are visible downstream; locals written AFTER `next()` returns are not magically visible to the already-run loader — document).
2. `params` on `req` equals the loader ctx `params` (same source, decoded — the 0.1.48 decode applies).
3. httpError from a loader never reaches the errorBoundary and never logs as a 500.
4. notFound()/redirect() behavior byte-identical.
5. Existing middleware/actions/loader tests unchanged.

## Tests

Unit: httpError trigger shape/guard/validation (400-599, body forms, headers); locals object identity through composeChain (pure function — testable without server).
Integration (all four paths): middleware sees params (412 short-circuit on `blocked`); locals flow middleware→loader→rendered HTML; React loader 403 with body + content-type + custom header; native loader 403 fast-lane; SPA-nav request to the 403 route gets 403; 404/redirect regression (existing tests stay green).

## Acceptance criteria

Full `bun test` (pre-existing fail exempt) + `bun run ci` green; no Rust changes expected (status already flows through RouteResponse/meta paths — verify; if the native fast-lane clamps statuses, that's a Rust touch to widen, document it).

## Open questions resolved at plan-time

- Exact construction sites of BrustRequest (grep) and the SPA-nav notFound signaling shape.
- Whether native fast-lane accepts arbitrary status codes in meta (expected yes — middleware already short-circuits 401 today through the same path).
