# 404 Layout / Page Support — Design

**Date:** 2026-06-12
**Status:** Spec (autonomous pipeline)

## Goal

First-class "not found" support in the framework: an app declares a 404 page as a
catch-all route (`{ path: '*' }`). Placed as a child of a layout it renders the
404 **inside that layout's chain** (the "404 Layout" — e.g. the docs 404 keeps the
sidebar); placed at the root it is the **global 404**. Unmatched requests render the
nearest catch-all at **HTTP 404** across every rendering path: Rust unmatched, native
(jinja), React streaming, SSG static export, and client-side SPA navigation.

This replaces the manual `example/docs/public/404.html` workaround with a real
framework feature, then dogfoods it in the docs site.

## Non-goals

- **Per-section 404 on static hosts (SSG).** Cloudflare Pages (and static hosts
  generally) serve a single root `404.html` for all unmatched paths. v1 SSG emits
  ONE `404.html` from the **global** (root) catch-all. Nested per-layout 404s are a
  **live-server / SPA-runtime** feature; on a static export every unmatched path
  shows the global 404. This limitation is documented, not worked around (no
  `_redirects` per-prefix 404 routing in v1).
- **Custom status codes other than 404.** The catch-all renders at 404. Arbitrary
  status pages (500, 403) are out of scope; React `errorBoundary` already covers 500.
- **Matchit catch-all routes.** We deliberately do NOT insert `{*rest}` into matchit
  (see Architecture / rejected alternative). No change to matchit pattern syntax for
  normal routes.
- **`*` as a general wildcard for matching real content.** `*` means "not found
  fallback for this subtree" only — it is never a 200 route.

## API surface

### Declaring a 404 (catch-all route)

A route whose `path` is exactly `'*'` is a **catch-all**: it is not inserted into the
live router as a matchable 200 route. Instead it is registered in a fallback table
keyed by its parent layout's path prefix, and rendered (with its full layout chain) at
status 404 when no real route matches under that prefix.

```ts
defineRoutes([
  { path: '/', Component: Home, native: true },

  { path: '/docs', Component: DocsLayout, children: [
      ...docPages,
      { path: '*', Component: DocsNotFound, native: true }, // 404 WITH docs chrome
  ]},

  { path: '*', Component: NotFound, native: true },          // global 404
])
```

- A catch-all is a **leaf** (no `children`, no `index`). Validated at flatten time.
- A catch-all MAY be `native: true` or a React component — both supported.
- A catch-all inherits its parent chain's layouts and **runs the layout loaders**
  (but NOT a sibling leaf's loader). Its own `loader` (optional) runs last.
- At most ONE catch-all per parent prefix (duplicate → flatten-time throw).
- The catch-all's effective prefix is its parent's `fullPath` (root catch-all →
  prefix `''`, matches everything).

### React `notFound()` trigger (parity with native verdict)

Native routes already have `notFound(data?)` returning a verdict (`runtime/routes.ts`
~:240) that renders the template at 404. React routes gain parity: a `notFound()`
helper callable from a React route **loader** (e.g. item-not-in-DB on `/items/{id}`).
It throws a tagged sentinel caught by the render dispatch, which then renders the
**nearest catch-all** for the route's prefix at status 404 (same selection as an
unmatched path), rather than the route's own Component.

```ts
import { notFound } from 'brustjs/routes'
{ path: '/items/{id}', Component: Item, loader: async ({ params }) => {
    const item = await db.find(params.id)
    if (!item) notFound()          // throws → renders nearest catch-all @ 404
    return { item }
}}
```

`notFound()` returns `never` (throws). If no catch-all is registered for the prefix,
it falls back to the framework default 404 body at status 404.

## High-level architecture

### Post-router fallback tier (the core mechanism)

The catch-all is resolved as a **second matching tier after matchit**, NOT as a matchit
route:

1. `Router::match_path` runs matchit as today. On `Matched` → unchanged.
2. On `NoMatch`, consult a new **not-found table**: an ordered list of
   `(prefix: String, route_id: u32)` pairs (the registered catch-alls). Select the
   entry whose `prefix` is the **longest** prefix of the requested path
   (segment-boundary aware: `/docs` is a prefix of `/docs/x` but not of `/docsy`).
   Root catch-all has prefix `""` and matches everything as the last resort.
3. Return a new `MatchResult::NotFound { route_id, envelope }` carrying the selected
   catch-all's `route_id` and a normal envelope (params empty; the path is in the
   request). The caller renders that flat route exactly like a matched one, but stamps
   **status 404**.
4. If the table is empty or nothing matches (shouldn't happen once root `""` exists)
   → the existing hardcoded `error_404()` plain-text body.

**Why a fallback tier, not a matchit `{*rest}` route:** matchit may reject a catch-all
that overlaps an existing single-segment param sibling (`/x/{name}` vs `/x/{*rest}`),
and catch-all precedence vs params is matchit-internal. A separate prefix-indexed tier
is conflict-free, gives us explicit longest-prefix precedence, and never shadows real
routes (it only runs on NoMatch). Static assets and `/_brust/*` are already handled
**before** route matching (server/mod.rs static branch precedes the match at ~:631), so
the global catch-all cannot swallow them.

### Status code threading

The 404 status must reach the HTTP response on every path. Today the native verdict
already carries `status` (routes.ts ~:989, ~:1164). We extend:

- **Rust unmatched (NotFound tier):** the JS render dispatch receives the selected
  catch-all route_id + a "render as 404" signal; it renders and returns a response
  whose status the Rust side already reads from the JS wrapper (native verdict path),
  or sets 404 for React.
- **Native catch-all:** reuse the verdict mechanism — the catch-all render injects an
  implicit `notFound()`-equivalent status (404) without the loader needing to call it.
- **React catch-all / `notFound()`:** the render dispatch sets response `status: 404`
  (same wrapper field the ActionError 404 path already uses, routes.ts ~:806/1299).

### Data flow per layer

| Layer | Unmatched path → | Status |
|---|---|---|
| Rust router | NotFound tier → JS renders catch-all flat route | 404 |
| Native (jinja) | catch-all template via existing napi render; verdict status | 404 |
| React streaming | catch-all Component via existing buildElementTree; wrapper status | 404 |
| SPA nav payload (`/_brust/page/*`) | NotFound tier → 404 payload with rendered body | 404 |
| SSG export | crawl GLOBAL catch-all at a sentinel path → `404.html` | (file) |
| SPA client (bootstrap) | 404 payload carries a real page → SWAP content, no full-reload | — |

## File structure

**Rust (`crates/brust-core`):**
- `src/routing/routes.rs` — add `NotFound` variant to `MatchResult`; add
  `not_found_table: RwLock<Vec<(String, u32)>>` to the router; populate it during
  install from a new per-config flag; add `select_not_found(path) -> Option<u32>`
  (longest segment-prefix match); call it in `match_path` on the NoMatch branch.
- `src/routing/config.rs` (or wherever `RouteConfig`/install structs live) — add a
  `not_found: bool` (+ `not_found_prefix: String`) field carried from JS per route.
- `src/server/mod.rs` — at the match site (~:631) handle `MatchResult::NotFound` by
  dispatching a render of the route_id with a 404 marker; keep `error_404()` as the
  last-resort when the tier yields nothing.

**TypeScript runtime:**
- `runtime/routes.ts` — flatten: detect `path === '*'` leaves, pull them OUT of the
  matchable set into a `notFound` descriptor on the flat table (with computed prefix);
  pass `not_found` + `not_found_prefix` to the Rust install payload; export
  `notFound()` React trigger (tagged throw) + the existing native `notFound()` stays;
  in the render dispatch, catch the React `notFound` sentinel and render the nearest
  catch-all at status 404; render a catch-all flat route at status 404.
- `runtime/islands/bootstrap.ts` — on SPA nav, when the page payload responds 404 but
  carries a rendered body/marker, APPLY it (content swap + URL + title) instead of the
  full-reload fallback; keep full-reload only for true transport errors.
- `runtime/cli/ssg.ts` — after crawling included routes, if a **global** catch-all
  exists and the app ships no `public/404.html`, crawl it (sentinel path) and write the
  rendered HTML to `staticOut/404.html` (replaces the fallback404Html stub for the
  no-fallback-routes case; the existing fallback-routes 404.html logic still applies
  and the two must compose — global 404 page is the base, fallback redirects layer in).

**Docs dogfood:**
- `example/docs/components/NotFound.tsx` (native) — branded 404, replaces the static
  `public/404.html` content; lives inside `DocsLayout` for the docs prefix AND as a
  root global. Remove `example/docs/public/404.html`.
- `example/docs/routes.tsx` — register the catch-all(s). If `mdRoutes` needs to host
  the docs-prefixed catch-all, add a `notFound?` option to `mdRoutes` (smallest change
  that lets the md layout own a 404 child); else register a root global only for v1 and
  note the docs-section-with-sidebar 404 as the mdRoutes follow-up.

## Behavior / invariants

1. A catch-all NEVER matches as a 200 route. `/docs/*` does not serve `/docs/x` if a
   real `/docs/x` exists; it only renders when matchit returns NoMatch under `/docs`.
2. Longest-prefix wins: `/docs/missing` → docs catch-all (if present) over root.
3. Segment-boundary prefixes: `/docs` prefix matches `/docs` and `/docs/...` but NOT
   `/docsearch`.
4. Every catch-all render returns status 404 — never 200.
5. Static assets, `/_brust/*`, action endpoints resolve BEFORE the not-found tier; a
   global catch-all cannot shadow them.
6. `notFound()` (React) is `never`-typed; renders the nearest catch-all, not the
   route's own Component.
7. SSG: exactly one `404.html` (global catch-all). App-authored `public/404.html`
   still wins (unchanged). Composes with existing `fallback:'client'` redirect 404.html
   — when both exist, the global 404 page is the document and the fallback-match script
   is injected (or: fallback routes keep their redirect doc; decided at plan time —
   must not regress the fallback feature).
8. Byte-identical output when an app declares NO catch-all (feature is purely additive;
   the not-found table is empty → existing `error_404()` path unchanged).

## Tests

**Rust (`crates/brust-core`):**
- `select_not_found`: longest-prefix, segment-boundary, root `""` last-resort, empty
  table → None.
- `match_path` returns `NotFound { route_id }` on unmatched when a catch-all is
  registered; returns `NoMatch`-equivalent (→ error_404) when table empty.
- Install carries `not_found` + prefix per config.
- Static-asset / `/_brust/` precedence unaffected (existing tests stay green).

**TypeScript (`runtime/`):**
- Flatten: `path:'*'` leaf is removed from matchable set, recorded with correct prefix;
  duplicate per prefix throws; catch-all with `children`/`index` throws.
- `notFound()` React trigger: tagged throw shape; dispatch renders nearest catch-all at
  404; no catch-all → default 404 body at 404.
- Native catch-all renders at 404 (verdict status).
- SPA bootstrap: a 404 payload with a body swaps content (no reload); a transport error
  still full-reloads.

**SSG (`runtime/cli/ssg.ts`):**
- Global catch-all → `404.html` written with rendered HTML; app `public/404.html` still
  wins; no catch-all → no framework 404.html (unchanged); compose with fallback routes.

**Integration / dogfood:**
- Build docs SSG → `dist/static/404.html` is the rendered NotFound page (not the old
  static file). Boot docs live → curl unmatched path → 404 status + NotFound body.

## Acceptance criteria

- [ ] Unmatched path on the live server renders the nearest catch-all at HTTP 404
      (native + React).
- [ ] Nested catch-all renders inside its layout chain (docs 404 has sidebar) on the
      live server / SPA.
- [ ] React loader `notFound()` renders the nearest catch-all at 404.
- [ ] SPA client nav to a missing path renders the 404 page in-place (no full reload).
- [ ] SSG export writes `404.html` from the global catch-all; docs `public/404.html`
      removed and the generated one ships.
- [ ] App with no catch-all: output and behavior byte-identical to today.
- [ ] Baselines green: cargo, runtime, integration, biome.

## Known limitations

- SSG static hosts get ONE global `404.html`; per-section sidebar-404 is live-only.
- `notFound()` from a React **component body** (vs loader) is out of scope for v1
  (loader-only trigger); the unmatched-path catch-all covers the common case.
- `mdRoutes`-hosted docs-section catch-all may need a small `mdRoutes` option; if it
  expands scope it can ship as a fast follow rather than blocking the core mechanism.

## Open questions resolved at plan time

- Exact field names for the Rust install payload (`not_found` vs `notFound` — napi
  camelCases, so the Rust `#[napi(object)]` field must be `notFound`/`notFoundPrefix`).
- Whether the catch-all gets a synthetic envelope or reuses the request envelope.
- SSG composition order when BOTH a global 404 page and `fallback:'client'` redirect
  404.html are needed (must not regress fallback routes).
