---
title: Routing
description: The route tree — nesting, layouts, loaders, params, middleware, and native chains.
nav: { group: "Concepts", order: 1 }
---

Routes are declared as a nested tree of plain objects and passed to
`defineRoutes` (from `brustjs/routes`), which flattens the tree into the table
the Rust router matches against. Structural mistakes — an index route with
children, a native route mixed into a React chain — throw at module load, before
the server binds.

## The Route shape

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Relative path segment in matchit syntax. `''` makes the node layout-only (contributes nothing to the URL). Mutually exclusive with `index`. |
| `index` | `boolean` | Matches the parent path exactly. Must be a leaf — no `children`, no `path`. |
| `Component` | `ComponentType` | The component rendered for this node. Required (and must be a **named** function) when `native: true`. |
| `loader` | `async ({ params, path, req }) => Data` | Runs in the worker before the render; its return value becomes the component's `data` prop (or, for native routes, the template context). |
| `native` | `boolean` | Compile this route's JSX to a template at build time and render it in Rust. See [Rendering Modes](/docs/rendering). |
| `children` | `Route[]` | Nested children; each child's path composes onto this node's path. |
| `middleware` | `Middleware[]` | Per-route middleware chain, concatenated with ancestors (parent runs first). |
| `errorBoundary` | `ComponentType<{ error: Error }>` | Invoked when Component or loader throws. Inherited by descendants that don't define their own (closest ancestor wins). |
| `cache` | `{ ttl_seconds, prefix?, bypass?, tags?, key?, key_ttl_seconds? }` | Opt-in two-layer page cache (declarative L1 + programmatic L2, tag/path invalidation). Read from the **leaf only**. Works on **native** routes too — a native L1 hit is served from Rust with zero worker dispatch. See [Caching](/docs/caching). |
| `ssg` | `{ params?, fallback?, placeholder? }` | Static-export config for dynamic-param routes, read **only** by `brust build --ssg`: `params()` enumerates the concrete paths to prerender; `fallback: 'client'` keeps the rest working on a static host via a client-side takeover (React routes only). See [Static Export (SSG)](/docs/static-export). |
| `sse` | `(req) => ReadableStream` | Stream a `text/event-stream` response. Cannot coexist with `Component`, `loader`, or `children`. |
| `websocket` | `() => Promise<WsHandlers>` | Accept WebSocket upgrades. Cannot coexist with `Component`, `loader`, `sse`, or `children`. |

The validation rules enforced at `defineRoutes` time:

- `index` and `path` are mutually exclusive; an index route cannot have children.
- Every node must have `path`, `index`, or `children`.
- An absolute child path (starting with `/`) is only allowed under a pathless
  (`''`) parent — otherwise the child would escape its parent's URL space.
- `native: true` requires a named `Component`, rejects `sse` / `websocket` /
  `cache`, and — if it has `children` — the **entire subtree must also be
  native**. A native leaf reached through a non-native ancestor is equally
  rejected: a native chain is composed into one template at build time, and a
  React node anywhere in it would break that.

## Params and wildcards

Path segments use matchit syntax. `{name}` matches exactly one segment and
lands in `params.name` as a string; `{*name}` is a catch-all that captures the
rest of the path.

```tsx
{ path: '/blog/{slug}', Component: Post, loader: async ({ params }) => getPost(params.slug) }
// /blog/hello → params.slug === 'hello'

{ path: '/files/{*rest}', Component: FileBrowser }
// /files/a/b/c → params.rest === 'a/b/c'
```

Param values are **percent-decoded** before they reach your loader (and the
`param()` cache-key accessor): `/post/sa%20wad-dee` gives `params.slug ===
'sa wad-dee'`, and Thai/Unicode slugs arrive as the original characters. The
decode is full — an encoded `%2F` becomes a literal `/` **inside the value**
(route matching itself happens before decoding, so it cannot change which
route matches), and `+` stays a literal `+` (space-as-plus is a query-string
convention, not a path one). Catch-all (`{*rest}`) captures decode the same
way. If you previously worked around encoded params with
`decodeURIComponent(params.x)`, remove it — double-decoding corrupts values
containing a literal `%`.

## Nesting, layouts, and `<Outlet/>`

A parent with `children` becomes a layout. On the React path the parent
renders the matched child wherever it places `<Outlet/>` (a React context
read; it renders nothing at a leaf):

```tsx
import { defineRoutes, Outlet } from 'brustjs/routes'

function AdminLayout() {
  return (
    <div>
      <nav>…</nav>
      <main><Outlet /></main>
    </div>
  )
}

export const routes = defineRoutes([
  {
    path: '/admin',
    Component: AdminLayout,
    children: [
      { index: true, Component: Dashboard },
      { path: 'users/{id}', Component: UserDetail },
    ],
  },
])
```

Along a matched chain:

- **Loaders run top-down** (parent → leaf). For native chains the results are
  shallow-merged into one flat context — child keys win over parent keys — and
  the first `notFound()`/`redirect()` verdict short-circuits the rest.
- **Middleware concatenates** root → leaf; the parent's middleware runs first.
- **`errorBoundary` is inherited** from the closest ancestor when the leaf has
  none.
- **`cache` comes from the leaf only.**

Native routes support the same nesting: a `native: true` parent with native
children compiles the whole chain into a single template per leaf at build
time (the layout's `<Outlet/>` becomes the splice point). The constraint is
that the chain must be native end to end.

## Index routes

`{ index: true }` matches the parent's path exactly — the conventional way to
give a layout a landing page, as in the `/admin` example above. An index route
is always a leaf.

## Middleware

Middleware is an Express/Koa-style chain over the structured request:

```ts
import type { Middleware } from 'brustjs/routes'

const requireAuth: Middleware = async (req, next) => {
  if (!req.cookies.session) {
    return { status: 302, body: '', headers: { Location: '/login' } }
  }
  const res = await next() // runs the rest of the chain (loader + render)
  res.headers = { ...res.headers, 'x-frame-options': 'DENY' }
  return res
}
```

Return a `RouteResponse` (`{ status, body, headers?, contentType? }`) without
calling `next()` to short-circuit, or call `await next()` and mutate the
result.

The request also carries the matched route context:

- `req.params` — the matched route params, percent-decoded, the **same values
  the loader ctx receives**. Authorize against `{id}` directly instead of
  re-parsing the raw URL. Empty object for routes without params (and for
  SSE/WS requests, whose envelope carries no params yet).
- `req.locals` — a request-scoped bag (`Record<string, unknown>`) middleware
  writes and loaders/handlers read. One object identity flows through the
  whole chain, so locals written before `next()` are visible downstream;
  writes after `next()` returns happen after the loader already ran.

```ts
const attachUser: Middleware = async (req, next) => {
  if (req.params.id === 'mine' && !req.cookies.session) {
    return { status: 403, body: 'no entry' }
  }
  req.locals.user = await verifySession(req.cookies.session)
  return next() // loader reads req.locals.user — one verification path
}

// later, in the route:
loader: async ({ req }) => ({ user: req.locals.user })
```

Two caveats:

- The response **cache lookup happens before any middleware** runs.
- On native routes, mutations made *after* `next()` (status, headers) are not
  forwarded — the Rust render path emits its own 200. Short-circuiting works
  everywhere. If your middleware must mutate the rendered response, use a
  React route.

## Cookies

Reading incoming cookies is structural — `req.cookies` on the request, as in
the middleware above. For *writing*, `brustjs` exports a request-scoped
helper usable anywhere inside a request (loader, middleware, action) without
threading the request through:

```ts
import { cookies } from 'brustjs'

loader: async ({ req }) => {
  const seen = cookies.get('seen')              // same data as req.cookies.seen
  cookies.set('seen', '1', { maxAge: 86_400, httpOnly: true, sameSite: 'Lax' })
  // cookies.delete('legacy')                   // Max-Age=0 under the hood
  return { firstVisit: !seen }
}
```

`set`/`delete` stage a `Set-Cookie` header that is flushed onto the response.
Options: `maxAge`, `expires`, `path`, `domain`, `secure`, `httpOnly`,
`sameSite: 'Strict' | 'Lax' | 'None'`. Values are URL-encoded; names are
validated as RFC 6265 tokens (header-injection guarded). `serializeCookie`
(same module) is the underlying one-liner if you build headers by hand.

One caveat: on **native routes** the Rust render path owns the response, so
staged `cookies.set()` calls are dropped — reading works everywhere, but set
cookies from an [action](/docs/actions) or a React route. Outside a request
scope, `set`/`delete` are no-ops (warned in dev).

## Request-scoped loader helpers

Loaders across a nested chain (or one loader called several times while
rendering) often want the same data. `brustjs` exports two per-request
memoizers — both scoped to the current request, both pass-through outside
one:

```ts
import { dedupe, cachedFetch } from 'brustjs'

// Share one in-flight promise + result for the request's lifetime:
const user = await dedupe('user:42', () => db.users.find(42))

// fetch() deduped per request for idempotent calls (GET/HEAD):
const res = await cachedFetch('https://api.example.com/pokemon/ditto')
```

`cachedFetch` keys on **method + URL only** (not headers/body) and returns a
fresh `Response` clone per call; non-idempotent methods bypass the cache.
Note the scope is a single request — for caching *across* requests, use the
response cache or [ISR islands](/docs/rendering#islands).

## notFound and redirect

A **native** route loader controls the HTTP response by returning a verdict
instead of data — both helpers come from `brustjs/routes`:

```ts
import { notFound, redirect } from 'brustjs/routes'

loader: async ({ params }) => {
  const post = await getPost(params.slug)
  if (!post) return notFound({ attempted: params.slug }) // 404, renders this route's own template
  if (post.movedTo) return redirect(`/blog/${post.movedTo}`, 301)
  return { post }
}
```

`notFound(data?)` renders the route's own template with HTTP 404 and `data`
(default `{}`) as the context. `redirect(location, status?)` emits a
`Location` header with no render; the status defaults to `302` and accepts
`301 | 302 | 303 | 307 | 308`. In a nested chain, the first verdict
encountered top-down wins and the remaining loaders are skipped.

## httpError

For any *other* error status, **throw** `httpError(status, body?, opts?)` from
a loader — React or native, same form on both:

```ts
import { httpError } from 'brustjs/routes'

loader: async ({ req }) => {
  const user = req.locals.user // written by your auth middleware
  if (!user) throw httpError(403, 'no entry', { headers: { 'www-authenticate': 'Cookie' } })
  return { user }
}
```

The response short-circuits with exactly that status — like a middleware
rejection, not an error: it never reaches the `errorBoundary` and never logs
as a 500. A string body ships as `text/plain` (override via
`opts.contentType`); an object body is JSON-encoded. The status must be an
integer in **400–599** — 3xx is `redirect()`'s job, and a 404 that renders a
page is `notFound()`'s. On a client-side navigation the non-2xx response
triggers the navigator's full-reload fallback, so the user lands on the real
document response.

## Next

How each route turns into HTML: [Rendering Modes](/docs/rendering).
