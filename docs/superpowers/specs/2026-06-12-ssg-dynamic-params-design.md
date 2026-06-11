# SSG Dynamic Params — `ssg.params()` expansion + client fallback

**Date:** 2026-06-12 · **Status:** approved-for-plan · **Branch:** `feat/ssg-dynamic-params`

## Goal

`brust build --ssg` can prerender dynamic-param routes (`/blog/{slug}`) from an
author-supplied param list (Next.js `generateStaticParams` equivalent), and —
opt-in per route — paths NOT in that list keep working on a dumb static host by
fetching data and rendering **on the client**, both for SPA clicks and direct
URL hits.

Shipped as two sequential phases on one branch:

- **Phase A** — `ssg.params()` build-time expansion. No client code.
- **Phase B** — `fallback: 'client'`: client loader + takeover runtime.

## Non-goals

- ISR / on-demand revalidation (needs a server; SSG targets dumb static hosts).
- `fallback: 'client'` for **native (jinja) routes** — Rust templates cannot
  render in the browser. Build error. (Native dynamic content can already use
  the island-fetch pattern.) md routes are native → same exclusion.
- Wildcard (`/files/*`) expansion or fallback — stays `skipped: wildcard`.
- Per-query-string export (`/blog?page=2`) — payload files are path-keyed.
  Pagination on static = path-based pages (`/blog/page/{n}` via `ssg.params`)
  or an island.
- Client-side rendering of the full layout chain. The fallback shell's chrome
  is server-rendered at build; the client renders the **leaf only** into the
  shell's mount container.
- SEO for non-prerendered paths (direct hits ride the host's 404 document —
  intentionally not indexable; index-worthy paths belong in `ssg.params`).
- Prefetching fallback chunks on hover (future nice-to-have).

## API surface

```tsx
// routes.tsx — Route gains one field
{
  path: '/blog/{slug}',
  Component: BlogPost,
  loader: async ({ params }) => getPost(params.slug),   // server loader, unchanged
  ssg: {
    /** generateStaticParams: concrete values to prerender. Sync or async. */
    params?: () =>
      | Array<Record<string, string>>
      | Promise<Array<Record<string, string>>>,
    /** What happens to paths NOT prerendered. Default 'none' (= today: skip → host 404). */
    fallback?: 'none' | 'client',
    /** Server-rendered loading UI baked into the fallback shell (Phase B).
     * Renders in the leaf position with NO data. Default: empty container. */
    placeholder?: ComponentType,
  },
}
```

```tsx
// components/BlogPost.tsx — clientLoader lives in the COMPONENT file
// (NOT routes.tsx: the fallback chunk imports this file into the browser, and
// routes.tsx drags server-only deps. Mirrors the `export const behavior`
// single-file convention.)
export const clientLoader = async ({ params, path }: {
  params: Record<string, string>
  path: string
}) => {
  const { data, error } = await client.api.posts({ slug: params.slug }).get()
  if (error) throw error
  document.title = data.title   // runs in the browser — author controls head
  return data
}

export default function BlogPost({ params, data }: { params: { slug: string }; data: Post }) { ... }
```

`Route.ssg` is read ONLY by `brust build --ssg`. Live server / dev render
dynamic routes on demand as today and ignore it entirely.

## Phase A — build-time expansion

### Behavior

1. New pure step `expandDynamicRoutes(flatRoutes)` (in `runtime/cli/ssg.ts`),
   awaited by `build.ts` step 8 **before** `collectStaticPaths`:
   - For each flat route whose `fullPath` contains `{param}` and whose **leaf**
     chain node has `ssg.params`: call it (build process = server context; DB
     access fine), and for each returned record produce a concrete path by
     replacing every `{name}` with `encodeURIComponent(record[name])`.
   - Emitted as additional `FlatRouteLike` entries (same `chain` reference)
     **appended** to the list handed to `collectStaticPaths`; the pattern route
     itself stays in the ORIGINAL list position and is never re-appended (so
     reason counting sees it exactly once). Concrete paths contain no `{}` so
     the existing include/crawl/payload pipeline handles them untouched.
   - `expandDynamicRoutes` reads `ssg` off the leaf chain node via a widened
     structural chain type `{ sse?; websocket?; native?; ssg?: RouteSsgLike }`
     (the `Route` object IS stored in `chain`, so the field survives
     flattening; existing `FlatRouteLike` consumers unchanged).
2. Validation (throw → build exits 1, matching existing ssg error path):
   - A record missing any `{name}` in the pattern, or containing an empty
     string value → `Error("ssg.params for /blog/{slug}: record #2 missing 'slug'")`.
   - `ssg.params` returning non-array → error.
   - `ssg` on a route with NO `{param}` in fullPath → error (dead config).
   - Duplicate records → deduped silently (Set on concrete path).
   - Any param value equal to the reserved sentinel `__brust_fallback__` →
     error (prevents the Phase B sentinel misfire foot-gun).
3. `ssg.params()` throwing → build fails with the route pattern in the message.
4. The pattern route itself stays excluded (`reason: 'dynamic-param'`) —
   reporting line gains the expansion count:
   `ssg: 23 pages + 23 spa payloads → … (expanded /blog/{slug}: 20; skipped 1: dynamic-param=1)`.
5. `fallback: 'client'` and `placeholder` are **accepted and type-checked in
   Phase A but inert** (Phase B activates both — the full `RouteSsgConfig`
   type ships once in Phase A to avoid churn). `fallback` on a `native: true`
   route → build error already in Phase A (fail early, the config can never
   work).

### Files (Phase A)

| File | Change |
|---|---|
| `runtime/routes.ts` | `Route.ssg?: RouteSsgConfig` type + JSDoc. `FlatRouteLike` consumers unaffected (`ssg` read from `chain` leaf). |
| `runtime/cli/ssg.ts` | `expandDynamicRoutes` + `RouteSsgConfigLike` structural type; export for tests. |
| `runtime/cli/build.ts` | Await expansion in step 8; pass expanded list to `collectStaticPaths`; report counts. |
| `runtime/cli/ssg.test.ts` | Unit: expansion, encoding, validation errors, dedupe, no-ssg passthrough. |
| `tests/fixtures/app/routes.tsx` + new `components/SsgBlogPost.tsx` | Fixture route `/ssg-blog/{slug}` with `ssg.params: () => [{slug:'hello'},{slug:'sa wad-dee'}]` (space tests encoding). The fixture's EXISTING `/blog/{slug}` (no `ssg`) stays untouched — `ssg.test.ts` hardcodes it as the `dynamic-param` skip case (lines 159/169/221); those assertions must remain green. |
| e2e (`ssg.test.ts` exportStatic section) | Built fixture dist exports `ssg-blog/hello/index.html` + nav payload; pattern route still skipped. |
| `example/docs/content/markdown-pages.md` (Static export section) | Document `ssg.params`. |

## Phase B — `fallback: 'client'`

### Moving parts

1. **Sentinel shell render** (worker TS, `runtime/routes.ts` makeRenderer area —
   zero Rust): a request whose matched route has leaf `ssg.fallback === 'client'`,
   where every `{param}` value is the literal `__brust_fallback__`, **and** the
   request carries header `x-brust-ssg: 1` (the build crawler sends it; absent →
   normal render, so the sentinel is unreachable on live traffic) renders:
   - the chain normally (parent loaders run — layouts need their data),
   - the **leaf replaced** by
     `<div data-brust-fallback-root data-brust-fallback="<fullPath pattern>">{placeholder ?? null}</div>`,
   - leaf loader skipped,
   - islands importmap + bootstrap injection FORCED via a new
     `forceIslands?: boolean` field on `RenderBranchStreamingArgs`
     (`runtime/render/stream.ts` — the injection decision is the
     `islandUsedBox.used` gate in the buffering-sink assembly; the flag ORs
     into it). TS-only; "zero Rust" still holds, but the render-pipeline
     contract change is in scope and listed in the file table.
   - Threat model note: a live request forging `x-brust-ssg: 1` + the sentinel
     path gets the placeholder shell — which renders LESS than a normal
     request (leaf loader skipped, no data). No enforcement beyond the header
     gate is needed; the expansion-time sentinel-value validation (Phase A)
     keeps real data out of the sentinel namespace.
2. **Build emission** (`ssg.ts` exportStatic + `build.ts`): for each
   `fallback: 'client'` route —
   - crawl `GET <pattern with every {x}→__brust_fallback__>` (+ header) →
     write `_brust/fallback/<pattern with {x}→__x__>/index.html` (full shell doc),
   - crawl the matching `/_brust/page/...` payload (+ header) →
     `_brust/fallback-page/<…>/index.html`,
   - build a **fallback chunk** per route: generated entry
     `import C, { clientLoader } from '<leaf component source>'; export { C as Component, clientLoader }`,
     bundled via the existing islands `buildOne` (react externals + importmap,
     content-addressed name `Fallback_<Name>_<hash>.js`).
     **Leaf source resolution**: reuse the `scanImports` resolution from
     `runtime/cli/native-routes-emit.ts` (the same machinery that maps a
     routes.tsx `Component:` identifier to its source file for native emit).
     Its known limit — **default imports only** — becomes a documented
     constraint: a `fallback: 'client'` leaf Component must be a default
     import in routes.tsx; unresolvable → build error naming the route and
     the constraint. Component file NOT exporting `clientLoader` → build
     error.
     **Browser-safety convention** (documented): the leaf component file's
     top-level imports must be browser-safe — server-only deps (DB clients,
     node builtins) belong in routes.tsx's `loader` or behind dynamic import
     inside it; violations surface as fallback-chunk bundle errors at build.
   - emit `_brust/routes.json`:
     `{ version: 1, fallbacks: [{ pattern, doc, payload, chunk }] }`. No
     fallback routes → file not written.
   - emit `404.html` (skip + warn if the app's `public/404.html` exists):
     inline manifest + matcher; on match →
     `sessionStorage.setItem('brust:fallback-path', location.pathname + location.search)`
     → `location.replace(doc)`. No match → plain 404 text.
3. **Client takeover runtime** (new `runtime/islands/fallback.ts`, imported by
   `bootstrap.ts`):
   - `matchFallback(pattern, pathname)` — segment matcher: `{x}` captures one
     decoded segment, all else literal. Exported for unit tests.
   - `takeover(container)`: read pattern from `data-brust-fallback`, params
     from the CURRENT pathname, `import(chunk)` → `clientLoader({ params, path })`
     → `unmountIslandsIn(container)` (a placeholder may carry islands) →
     `createRoot(container).render(createElement(Component, { params, path, data }))`
     (matches the server prop shape minus `req`/`workerId` — documented).
     Roots tracked in fallback.ts's OWN `fallbackRoots` WeakMap; fallback.ts
     exports `unmountFallbackRootsIn(root)` which bootstrap's
     `unmountIslandsIn` calls (islandRoots stays module-private).
     `clientLoader` throw → `console.error` + container keeps the placeholder +
     `data-brust-fallback-error` attr set (author-level recovery = catch inside
     clientLoader and return error-shaped data).
   - **Boot path** (direct hit): after `__navInit`, if
     `[data-brust-fallback-root]` exists in the document → consume the
     sessionStorage path (when present) via `history.replaceState` **before**
     `takeover` starts (the real URL shows while the placeholder loads) →
     `takeover`.
   - **Navigate path** (SPA click): `fetchPagePayload` THROWS on `!resp.ok`
     (`navigation: status NNN`). The hook is in `navigate()`'s fetch branch:
     wrap the direct-fetch call; on a non-Abort error, call
     `attemptClientFallback(url): Promise<boolean>` —
     lazily fetch `/_brust/routes.json` (memoized; 404/invalid → empty list =
     today's behavior) → pattern match → fetch the **manifest's `payload` URL**
     (`/_brust/fallback-page/...`, NOT `/_brust/page/...` — only the former
     exists on a static host) → swap it into `<main>` (normal swap path:
     scroll save, history push, title) → `takeover` on the swapped container →
     `__navCommit` only after takeover resolves (so `phase: 'loading'` covers
     the client fetch — NavPreloader stays honest) → return true. Any failure
     or no match → return false → rethrow to the existing catch (full-reload
     fallback, unchanged).
4. **Page-cache interplay**: client-rendered results are NOT cached in the
   payload cache (no payload html exists; data freshness belongs to
   clientLoader). The fallback *payload* (placeholder shell) MAY be cached —
   harmless, it's static. Prefetch of a non-prerendered link 404s silently
   (already the prefetch contract).
5. **unmount integration**: `unmountIslandsIn` additionally queries
   `[data-brust-fallback-root]` and unmounts the tracked root (same WeakMap
   discipline as island roots — detached React roots hang the tab).

### Files (Phase B)

| File | Change |
|---|---|
| `runtime/routes.ts` | Sentinel branch in the render path (chain assembly): header read from the call's `req`, leaf swap, leaf-loader skip. |
| `runtime/render/stream.ts` | `RenderBranchStreamingArgs.forceIslands?: boolean` ORed into the `islandUsedBox.used` injection gate. |
| `runtime/cli/ssg.ts` | Fallback crawl/emit + manifest + 404.html + sanitized path helpers. |
| `runtime/cli/build.ts` | Fallback chunk build step (entry generation + leaf source resolution) before SSG crawl. |
| `runtime/islands/fallback.ts` (NEW) | matcher + takeover + manifest fetch (memoized). |
| `runtime/islands/bootstrap.ts` | boot-path check; navigate() fetch-error hook (`attemptClientFallback`); `unmountIslandsIn` delegates to `unmountFallbackRootsIn`. |
| Tests | unit (matcher, manifest memoization, entry generation, sanitized names) + ssg e2e (fallback files exist, payload is JSON, 404.html emitted, sentinel not honored without header) + browser verify (Phase 6: serve static export, click a non-prerendered slug → client render; direct-hit via 404 redirect). |
| `example/docs/content/markdown-pages.md` + `routing.md` | Document fallback, clientLoader convention, 404.html, host notes. |

## Invariants

- **Zero Rust changes.** Sentinel + header logic is worker TS; everything else
  is build/CLI/browser TS.
- Without `ssg` config, `--ssg` output is byte-identical to today (no
  routes.json, no 404.html, no fallback dirs, same decisions).
- Live server behavior unchanged for all routes (header-gated sentinel).
- Sentinel value `__brust_fallback__` is reserved and documented; a real page
  whose param equals it AND sends the internal header is out of contract.
- `fallback: 'client'` + `native: true` → build error. `fallback: 'client'`
  with no `clientLoader` export in the leaf component file → build error.
- Build fails loudly (exit 1) on any expansion/validation error — never a
  silent partial export (matches exportStatic's no-partial-site rule).

## Acceptance criteria

**Phase A**
1. Fixture `/ssg-blog/{slug}` with 2 params → export contains both concrete
   pages + payloads; URL-encoding correct for the space value; pattern route
   skipped as `dynamic-param`; all existing ssg tests still green.
2. Validation errors (missing key, native+fallback, ssg-on-static-route) fail
   the build with route-pattern-bearing messages — each covered by a unit test.

**Phase B**
3. Static export of the fixture serves: prerendered slug → static HTML
   (no takeover); non-prerendered slug clicked from a list → placeholder swap
   then client-rendered data, **no full reload**; direct URL hit →
   404.html redirect → shell → client render with original URL restored.
4. `bun test runtime/` + ssg/cli/native-island/integration suites green;
   browser-verified on a real static file server (not the live brust server).

## Known limitations (documented, accepted)

- Client-rendered pages get props `{ params, path, data }` only — no `req`,
  no `workerId` (they don't exist in a browser).
- Direct hits on non-prerendered paths return HTTP 404 + a visible URL swap
  via the redirect hop (spa-github-pages pattern) — chosen over `_redirects`
  splat rewrites, which shadow prerendered files on Cloudflare Pages.
- `errorBoundary` does not wrap clientLoader failures (catch inside
  clientLoader for custom error UI).
- Head beyond `document.title` is not patchable on the client.
