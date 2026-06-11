---
title: Markdown Pages
description: mdRoutes and mdNav — file-based markdown content with frontmatter, live embedded components, and a frozen manifest for dist.
nav: { group: "Guides", order: 7 }
---

Every page in this documentation — including the one you are reading — is a
markdown file under `content/`, turned into a native route by `mdRoutes` (from
`brustjs/routes`). At build time each file is rendered to HTML, compiled into
a jinja template like any other native page, and served by Rust; embedded
component tags become live islands or behavior components. This page is the
dogfood: it embeds two working demos further down.

## mdRoutes

```ts
import { mdRoutes } from 'brustjs/routes'

const routes = mdRoutes(contentDir, options?)
```

`mdRoutes(contentDir, opts)` scans a directory of `.md` files and returns
`Route[]` — ordinary `native: true` routes you spread into `defineRoutes`.

| Option | Type | Default | Description |
|---|---|---|---|
| `prefix` | `string` | `'/'` | URL prefix the pages mount under. Trailing slashes are normalized (`/docs/` ≡ `/docs`). |
| `layout` | `ComponentType` | — | Optional layout component. When set, `mdRoutes` returns **one** parent route `{ path: prefix, Component: layout, children: […leaves] }`; the layout owns the document shell and renders each page at its `<Outlet/>`. Must be a **named** component. |
| `components` | `Record<string, ComponentType>` | `{}` | Registry for `<Name />` tags embedded in page bodies (see below). |

Without `layout`, the returned leaves carry full prefixed paths; with it, the
children carry prefix-relative paths under the single parent. Each leaf is a
native route with a synthetic named component and a generated loader that
exposes the frontmatter head fields as `{ __md: { title, description } }` —
on a chained route those merge into the layout's loader data like any
[nested-route](/docs/routing) chain (this site's layout reads them for
`<title>` and the meta description).

### File → URL mapping

A file's path relative to `contentDir` is its URL under `prefix`:

| File | URL (prefix `/docs`) |
|---|---|
| `index.md` | `/docs` |
| `installation.md` | `/docs/installation` |
| `guide/index.md` | `/docs/guide` |
| `query/where.md` | `/docs/query/where` |

With the default prefix `'/'`, `index.md` is `/`.

## Frontmatter

A leading `---` … `---` block. The parser is a deliberate YAML **subset** (no
yaml dependency): `key: value` lines with double-quoted strings (JSON
escapes), single-quoted strings (no escapes), bare strings, numbers, and
booleans. Nested maps use the **inline-braces form only** — indented child
keys throw with a `file:line` error.

```yaml
---
title: Markdown Pages              # <title>, sidebar, search
description: One-line summary.     # <meta name="description">
nav: { group: "Guides", order: 7 } # sidebar bucket + sort key
---
```

Files without a frontmatter block get an empty one; the title then falls back
to the file stem in navigation.

## mdNav

```ts
import { mdNav } from 'brustjs/routes'

const groups = mdNav(contentDir) // MdNavGroup[]
```

`mdNav` returns the navigation model for a content dir:

```ts
interface MdNavGroup {
  group: string | null // frontmatter nav.group; null = ungrouped
  items: { title: string; path: string; order?: number }[]
}
```

Pages are sorted by `nav.order` (missing order sorts last) then title, and
bucketed by `nav.group` — ungrouped pages land in a `group: null` bucket.
Two things to know:

- **Sorting is global, not per group.** Group order follows the *first
  appearance* of each group in the sorted page sequence, so a group's position
  is set by its lowest-ordered page. This site numbers `nav.order`
  sequentially across all groups to keep the sidebar sections in reading
  order.
- Paths use the prefix the dir was mounted under by `mdRoutes` (recorded when
  `routes.tsx` runs; `'/'` if `mdRoutes` was never called for that dir).

This site's sidebar and prev/next pager are both `mdNav` output, computed in
the layout route's loader.

## Embedding components

A line consisting of a **self-closing, capitalized tag** — at the top level of
the page, outside any code fence — embeds a component:

```md
<DemoCounter start={3} />
<DemoCounter start={0} hydrate="visible" />
<DemoCounter csr />
<DemoBadge />
```

Props are literals:

| Form | Example | Value |
|---|---|---|
| `p="str"` | `label="docs"` | The string, verbatim (no escapes). |
| `p={…}` | `start={42}`, `live={true}` | The `{…}` content, `JSON.parse`d — numbers, booleans, `null`. |
| `p={{…}}` | `cfg={{"a":1}}` | A JSON object (or array). |
| `flag` | `csr` | `true`. |

Two attribute names are reserved and pulled out of the props:

- `hydrate="load|idle|visible|interaction"` — island hydration timing
  (default `load`).
- `csr` — client-side-render only: the host div ships empty (no SSR HTML) and
  the island renders entirely in the browser.

Malformed attributes, duplicate names, unbalanced braces, and non-self-closing
registry tags are build errors with `file:line`. And the strict corollary:
**any** bare line opening with a capitalized self-closing tag must resolve in
the registry — a literal example like the fence above fails the build unless
it sits inside a code fence (fences shield everything).

### Islands vs behavior components

The same tag grammar embeds two different kinds of component, told apart by
the component's source file:

- A **React island** (an ordinary React component) compiles to an island host
  — server-rendered HTML plus a hydration marker — exactly as if the page were
  TSX. `hydrate` and `csr` apply.
- A **behavior component** (a file with `export const behavior`, see
  [Native Interactivity](/docs/native-interactivity)) is inlined **fully
  statically** at build time, with its `x-data` directive auto-injected; the
  react-free directive chunk binds it in the browser. `hydrate`/`csr` are
  errors here, props must be **string or number literals** (they substitute
  into the static body — a body referencing anything non-literal is a hard
  build error), and a literal `x-data` on the component's root is rejected.

### Live demos

The next two lines of this page's source are component tags. First
`<DemoCounter start={3} />` — a React island with `useState`, server-rendered
then hydrated on load:

<DemoCounter start={3} />

And `<DemoBadge />` — a behavior component: the button below is static HTML in
the jinja template, wired by a react-free chunk through `x-on-click` and
`x-text`:

<DemoBadge />

### The three-identity rule

The md tag name, the key in the `components` registry, and the component's
**default import** ident in the routes entry must all be the same name — the
build resolves the tag through the routes entry's imports:

```tsx
// routes.tsx
import DemoBadge from './components/DemoBadge'     // 1. import ident
import DemoCounter from './components/DemoCounter'

mdRoutes('content', {
  prefix: '/docs',
  layout: DocsLayout,
  components: { DemoBadge, DemoCounter },          // 2. registry key
})
// 3. <DemoCounter … /> on a line in the .md file
```

A registry key with no matching default import fails the build with an error
naming all three identities.

## Braces are safe

Native templates are minijinja, so `{{ … }}` and `{% … %}` in markdown could
collide with template syntax. They don't: after markdown rendering, every
jinja delimiter that came from your content is neutralized so it renders back
as literal text — only the injected component-host markup keeps live template
syntax. Which is why this page can show you island host internals and raw
jinja in a fence:

```jinja
<div data-brust-island="DemoCounter_1a2b3c4d"
     data-brust-props="{{ island_0_props }}"
     data-brust-hydrate="load">{{ island_0_html | safe }}</div>

{% raw %} … {% endraw %}
```

…and inline too: {{ island_0_props }} renders literally in prose. No escaping
required, anywhere in a page.

## Markdown features

GFM (tables, strikethrough, task lists) via `marked`. Headings get slugified
`id`s automatically (duplicates deduped with `-2`, `-3`, …) — this site's
search index links straight to them. Code fences are highlighted server-side
by [shiki](https://shiki.style) with dual `github-light`/`github-dark`
CSS-variable themes; shiki is an **optional** dependency — without it fences
degrade to escaped `<pre><code>` with one build warning, and an unknown
language degrades silently per fence.

## The frozen manifest

`brust build` writes `<out-dir>/md-manifest.json` next to the compiled
templates:

```json
{
  "version": 1,
  "contentDir": "content",
  "entries": [
    {
      "relPath": "markdown-pages.md",
      "templateName": "Md_markdown_pages_md_4af0…",
      "urlPath": "/docs/markdown-pages",
      "frontmatter": { "title": "Markdown Pages", "nav": { "group": "Guides", "order": 7 } }
    }
  ]
}
```

A prebuilt dist boots its md routes **from this manifest** — the markdown
content directory does not need to ship with the deploy. `mdNav` reads it too,
recomputing each `urlPath` from `relPath` plus the live prefix so links can
never diverge from the routes.

In dev and source mode the filesystem is the truth instead: edits to an
existing `.md` file hot-reload, but **adding or removing** a file needs a
restart — the route table is frozen at boot, and the dev server warns
`md routes changed — restart required` once when it notices.

## Static export (--ssg)

`brust build --ssg` prerenders the site to plain HTML after the build:

```bash
brust build index.ts --ssg                  # → dist/static
brust build index.ts --ssg --ssg-out site   # custom output dir
```

It boots the just-built dist once on an ephemeral port, crawls every
statically-renderable route, and writes `<path>/index.html` per page (`/` →
`index.html`, `/docs/intro` → `docs/intro/index.html`). Routes are skipped
when they cannot be a static file:

| Skipped | Why |
|---|---|
| `/blog/{slug}` | dynamic param — the page set is unknown at build time |
| `/files/{*rest}` | wildcard |
| `sse` routes | a stream is not a file |
| `websocket` routes | likewise |

Everything else must answer **200** — any other status fails the whole export
and removes the partial output, so a broken page can never ship silently.
Assets are copied preserving the live server's URL shape: island chunks under
`/_brust/islands/`, CSS under `/_brust/css/`, and `public/` mapped to the
root.

**SPA navigation works statically.** Alongside each page the export writes
the route's navigation payload at `_brust/page/<path>/index.html` — the same
`{html, title, store}` JSON the live server answers at `/_brust/page/<path>`.
Internal links on the static site therefore swap `<main>` client-side instead
of full-reloading, exactly like the live server (this site does it — click the
sidebar; the whole mechanism is documented in [Navigation](/docs/navigation)). Cross-shell navigations (a page without a shared `<main>`, like this
site's Home) detect a full-document payload and fall back to a normal load.

### Dynamic routes — ssg.params

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

Routes with `{param}` and **no** `ssg.params` continue to be skipped — today's
behavior is unchanged for routes you have not opted in to.

For static-friendly pagination, model pages as path segments rather than query
params: `/blog/page/{n}` with `ssg.params` returning `[{ n: '1' }, { n: '2' }, …]`.

**Root path only:** every generated URL is root-absolute. Deploy the export at
a domain root (`docs.example.com`), not under a subpath — `example.com/docs/`
would 404 every asset.

### Cloudflare Pages

The export is a plain directory — no functions, no adapter. For this site:

| Setting | Value |
|---|---|
| Build command | `bun install && bun run build:ssg` *(whatever runs `brust build … --ssg`)* |
| Build output directory | `dist/static` |

The same directory works on any static host that serves `<path>/index.html`
for `<path>` (Pages, Netlify, `nginx try_files`).

## Next

Shipping the server build (and when to prefer it over static):
[Deployment](/docs/deployment).
