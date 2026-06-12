---
title: Static Export (SSG)
description: brust build --ssg — prerender to plain HTML, generate dynamic routes with ssg.params, and keep the long tail working on a static host with fallback client.
nav: { group: "Guides", order: 8 }
---

`brust build --ssg` prerenders the site to plain HTML after the build — no
server, no functions, no adapter. The output is a directory any static host
can serve. This documentation site is exactly that: a static export on
Cloudflare Pages, navigating SPA-style with no server at all.

```bash
brust build index.ts --ssg                  # → dist/static
brust build index.ts --ssg --ssg-out site   # custom output dir
```

The build boots the just-built dist once on an ephemeral port, crawls every
statically-renderable route, and writes `<path>/index.html` per page (`/` →
`index.html`, `/docs/intro` → `docs/intro/index.html`).

Everything crawled must answer **200** — any other status fails the whole
export and removes the partial output, so a broken page can never ship
silently. Assets are copied preserving the live server's URL shape: island
chunks under `/_brust/islands/`, CSS under `/_brust/css/`, and `public/`
mapped to the root.

Routes are skipped when they cannot be a static file:

| Skipped | Why |
|---|---|
| `/blog/{slug}` (without `ssg.params`) | dynamic param — the page set is unknown at build time |
| `/files/{*rest}` | wildcard |
| `sse` routes | a stream is not a file |
| `websocket` routes | likewise |

**SPA navigation works statically.** Alongside each page the export writes
the route's navigation payload at `_brust/page/<path>/index.html` — the same
`{html, title, store}` JSON the live server answers at `/_brust/page/<path>`.
Internal links on the static site therefore swap `<main>` client-side instead
of full-reloading, exactly like the live server (this site does it — click the
sidebar; the whole mechanism, including the in-memory page cache and hover
prefetch, is documented in [Navigation](/docs/navigation)). Cross-shell
navigations (a page without a shared `<main>`, like this site's Home) detect a
full-document payload and fall back to a normal load.

**Root path only:** every generated URL is root-absolute. Deploy the export at
a domain root (`docs.example.com`), not under a subpath — `example.com/docs/`
would 404 every asset.

## Dynamic routes — ssg.params

Routes with `{param}` segments are skipped by default because the page set is
unknown at build time. Add `ssg.params` to the route to tell the build which
concrete paths to prerender:

```ts
{ path: '/blog/{slug}', Component: BlogPost,
  loader: async ({ params }) => {
    const post = await getPost(params.slug)
    return { post }
  },
  ssg: {
    params: async () => (await listPosts()).map(p => ({ slug: p.slug })),
  } },
```

`ssg.params` is called once at build time; it may be async (a database or CMS
call is fine). The server loader is **unchanged** — it runs at build time for
each concrete path with the same `params` it would receive at runtime, so data
fetching and rendering are identical.

One sharp edge for non-URL-safe values: the router does **not** decode path
segments, at build time or live — `params.slug` inside the loader receives the
**percent-encoded** form (`"sa%20wad-dee"`, not `"sa wad-dee"`). If your slugs
can contain spaces or non-ASCII characters, `decodeURIComponent(params.slug)`
in the loader before the lookup. Plain URL-safe slugs are unaffected.

Routes with `{param}` and **no** `ssg.params` continue to be skipped — the
default is unchanged for routes you have not opted in to.

For static-friendly pagination, model pages as path segments rather than query
params: `/blog/page/{n}` with `ssg.params` returning `[{ n: '1' }, { n: '2' }, …]`
— query strings cannot be exported as separate files.

## Client fallback — ssg.fallback: 'client'

`ssg.params` covers the pages you can enumerate. For the long tail — a path
set too large or too fresh to prerender — add `fallback: 'client'` and the
route keeps working on a static host:

```ts
{ path: '/blog/{slug}', Component: BlogPost,
  loader: async ({ params }) => ({ post: await getPost(params.slug) }),
  ssg: {
    params: async () => (await listRecentPosts()).map(p => ({ slug: p.slug })),
    fallback: 'client',
    placeholder: PostSkeleton, // optional — server-rendered loading UI
  } },
```

Prerendered paths still ship as plain HTML, exactly as before. Any **other**
path renders in the browser instead: the export ships a server-rendered
fallback shell for the route (your `placeholder` component renders in the
leaf position while data loads; omit it for an empty container), and the
client fills it by running a `clientLoader` you export **from the component
file** (not `routes.tsx` — the fallback chunk imports this file into the
browser, and `routes.tsx` drags server-only dependencies):

```tsx
// components/BlogPost.tsx — same file as the component
export const clientLoader = async ({ params, path }: {
  params: Record<string, string>
  path: string
}) => {
  const resp = await fetch(`/api/posts/${params.slug}`)
  if (!resp.ok) throw new Error(`post: ${resp.status}`)
  const data = await resp.json()
  document.title = data.title // runs in the browser — set the title here
  return data
}

export default function BlogPost({ params, data }) { /* … */ }
```

Two conventions make the chunk buildable: the component must be a **default
import** in `routes.tsx`, and the component file's top-level imports must be
**browser-safe** — DB clients and node builtins belong in the route's server
`loader`, not here. Violations fail the build with the route named.

**What gets emitted.** Alongside the prerendered pages, per fallback route:
a fallback shell document at `_brust/fallback/<pattern>/index.html` and its
SPA payload at `_brust/fallback-page/<pattern>/index.html` (each `{slug}`
sanitized to `__slug__` on disk), a per-route client chunk under
`_brust/islands/` — plus one `_brust/routes.json` manifest and a `404.html`
at the root (skipped with a warning if your own `public/404.html` exists).
The islands runtime ships even when the app has zero islands — the takeover
runs in the same bootstrap that drives SPA navigation.

**How a visit resolves.** An internal click onto a non-prerendered path swaps
in the fallback shell and runs `clientLoader` — no full reload, and the
navigation `phase` stays `'loading'` until the data lands, so a progress
indicator built on [`useNav()`](/docs/navigation) stays honest. A direct URL
hit goes through the host's 404 page: `404.html` matches the path against the
manifest, redirects to the shell, the original URL is restored, then the
client fetch fills the page. The build produces the shell by requesting the
route with every param set to the reserved sentinel `__brust_fallback__` —
that value can never be a real param (`ssg.params` returning it fails the
build).

Accepted limitations:

- **React routes only** — a `native: true` (jinja) route cannot client-render;
  `fallback: 'client'` on one fails the build. Native pages with dynamic
  content can use an island that fetches instead.
- Direct hits answer HTTP **404** at the protocol level (the
  spa-github-pages pattern) — fine for app pages, wrong for SEO-critical
  ones; prerender those via `ssg.params`.
- Client-rendered props are `{ params, path, data }` only — no `req`, no
  `workerId` (they don't exist in a browser).
- `errorBoundary` does not wrap a `clientLoader` failure — catch inside
  `clientLoader` and return error-shaped data for custom error UI.
- Head patching is limited to `document.title`, settable inside
  `clientLoader` as above.

## Hosting

The export is a plain directory. For Cloudflare Pages (this site):

| Setting | Value |
|---|---|
| Build command | `bun install && bun run build:ssg` *(whatever runs `brust build … --ssg`)* |
| Build output directory | `dist/static` |

The same directory works on any static host that serves `<path>/index.html`
for `<path>` and a root `404.html` for unknown paths (Pages, Netlify, GitHub
Pages, `nginx try_files`). Avoid catch-all `_redirects` 200 rewrites for
fallback routes — on Cloudflare Pages they shadow the prerendered files; the
generated `404.html` flow needs no host configuration at all.

## Next

Markdown content that feeds this pipeline: [Markdown Pages](/docs/markdown-pages).
Shipping the server build instead (and when to prefer it):
[Deployment](/docs/deployment).
