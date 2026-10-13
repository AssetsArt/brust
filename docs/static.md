# Static output: `brust build --target static`

`--target static` builds the normal `dist/`, then renders every page through the real server and writes the pages as files to `dist/static/`. You can upload that directory to Cloudflare Pages, or serve it with Workers Static Assets. Neither needs a server or a Worker. `brust start` still works on the same `dist/`.

```sh
brust build routes.tsx --target static          # dist/ + dist/static/
brust build routes.tsx --target static --strict # a loader that reads the request fails the build
```

## 1. How a page is rendered

The build starts a child Bun process. It boots the same napi server as `brust start` on `127.0.0.1` on a free port, with the normal workers, and requests each page with `Accept-Encoding: identity`. Then it drains. A written page is byte-identical to what `brust start` sends for that path: the same templates, jobs, islands and scripts.

## 2. Which pages

| Route | Pages written |
|---|---|
| Static pattern (`/`, `/docs/intro`) | One. |
| Dynamic pattern (`/poke/{name}`) with `ssg: { params }` | One per record `params()` returns. |
| Dynamic pattern without `params` | Build error `ssg-params-missing`. |
| `ssg: false` | None. Listed under `skipped` in `ssg.json`. |
| The top-level `*` route | `404.html`, rendered at a path no route matches. The status must be 404. |

```tsx
{
  path: '/poke/{name}',
  Component: Poke,
  loader: ({ params }) => getPokemon(params.name),
  ssg: { params: async () => (await listPokemon()).map((p) => ({ name: p.name })) },
},
{ path: '/live/{id}', Component: Live, ssg: false },
```

`params` may be async and runs once, in the build. Each record needs a non-empty string for every `{name}` of the pattern. A `{name}` value is one path segment, so `/` is refused. A `{*rest}` value may contain `/`. Empty, `.` and `..` segments are refused (`ssg-params`). Values are percent-encoded in the request and decoded in the file name: `100%` is requested as `/poke/100%25` and written to `poke/100%.html`, and a Thai name is written under its Thai file name. Two records that write the same file are an error. A path segment that is not valid percent-encoding (a stray `%` in a static pattern) or a value that cannot be encoded is `ssg-param-encoding`. Two files that differ only by case (`About.html` and `about.html`) are `ssg-path-collision`, because macOS and Windows file systems would keep only one.

The server and Cloudflare targets ignore the `ssg` field. It is allowed only on leaf routes.

## 3. Output

```
dist/static/index.html            /
dist/static/docs.html             /docs
dist/static/docs/intro.html       /docs/intro
dist/static/404.html              the * route (or a default one, with a warning)
dist/static/_brust/client/*.js    runtime, native chunks and island chunks (immutable)
dist/static/public/**             ./public
dist/static/_headers              nosniff, X-Powered-By, cache-control for the assets
dist/static/_redirects            one line per redirect()
dist/static/ssg.json              pages, redirects, skipped routes, the 404 route, warnings
```

There is no manifest, Jinja, jobs or actions file in it. Assets follow the same rules as the Workers target: only the files the native host would serve are copied.

Without a `*` route, the build writes a minimal `404.html` and warns `ssg-404`. Without any `404.html`, Cloudflare Pages switches to SPA mode and answers every unknown path with the home page.

## 4. Responses

| The server answers | The build |
|---|---|
| 200 | Writes the file. |
| `redirect(location, status)` | Adds `<path> <location> <status>` to `_redirects`. The source is the decoded path, with only whitespace, control characters and `%` escaped, the form Pages matches (`/go/ไทย`). |
| Any other status on a planned path | Error `ssg-render`, with an excerpt of the body. |
| A body or `Location` naming the render server's loopback origin | Error `ssg-render`. A static page must not link back to the build machine. |
| No answer within `BRUST_SSG_PAGE_TIMEOUT_MS` (default 30 000) | Error `ssg-timeout` naming the path. |
| The whole render past `BRUST_SSG_TIMEOUT_MS` (default 600 000) | The render process is stopped; error `ssg-timeout` naming the path it was on. |
| Response headers set by a loader | Dropped, with warning `ssg-headers`. A static file carries none. |

## 5. Loaders see an empty request

While rendering, `req` is `{ method: 'GET', url, headers: {}, cookies: {}, search: {} }`. The page written is what a visitor with no cookies and no query sees. Every read of `req.headers`, `req.cookies` or `req.search`, whether a key, an `in` check or a listing, is reported as warning `ssg-request-read` with the route, the field and the key. `--strict` turns these warnings into a build error, and the previous `dist/` stays as it was.

## 6. Refused before rendering

These fail the build before anything is written:

| Rule | When |
|---|---|
| `ssg-actions-cache` | `[actions]` is configured together with a `[cache]` adapter that needs a Cloudflare binding (`cloudflare-kv`, `cloudflare-do`). The Pages Worker serves actions only, so the binding has nowhere to be used. Drop `[cache]`. See section 8. |
| `ssg-varies` | A rendered route's `cache.prefix` or `cache.bypass` reads `header()`, `cookie()`, `query()` or `request(host)`. The page varies per request, and a static file is one page for everyone. The read-set comes from the server's own key grammar (napi `cacheExprReads`). |
| `ssg-params-missing` / `ssg-params` | See section 2. |

`cache.ttl_seconds` and `[cache]` do not apply to static files. The build says so in an info line, and the render does not load the cache adapter, so a Redis or other backend does not have to be running at build time.

## 7. Deploy

**Cloudflare Pages.** Upload `dist/static` as the build output directory, for example with `wrangler pages deploy dist/static`. Pages serves `/docs` from `docs.html`, applies `_headers` and `_redirects`, and answers unknown paths with `404.html` and status 404.

**Workers Static Assets.** Point `assets.directory` at `dist/static` and set `not_found_handling = "404-page"`. `html_handling` should be `"auto-trailing-slash"`, the default, so `/docs` finds `docs.html`:

```jsonc
{
  "name": "my-site",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./dist/static", "not_found_handling": "404-page" }
}
```

Workers Static Assets also reads `_headers` and `_redirects`.

## 8. Static pages with actions

**Cloudflare Pages only.** This output is for `wrangler pages deploy`. Do not point Workers Static Assets at `dist/static` for it. The build writes a `.assetsignore` (`_worker.js`, `_routes.json` and `.assetsignore` itself) so those files are never uploaded as public assets, and `_routes.json` sends requests for them to the Worker, which answers 404, but Pages is the supported target.

When `[actions]` is configured, `--target static` writes the same static pages and also a Cloudflare Pages advanced-mode Worker that serves **only** the action prefix:

```
dist/static/
  _worker.js/index.js    the Worker: the action prefix goes to the Cloudflare core, anything else to env.ASSETS
  _worker.js/core/       the worker tree of --target cloudflare (wasm host + your actions.ts, bundled)
  _routes.json           { "version": 1, "include": ["<prefix>", "<prefix>/*", "/_worker.js", "/_worker.js/*", "/_routes.json", "/.assetsignore"], "exclude": [] }
dist/wrangler.jsonc    the Pages project file: name, compatibility date, pages_build_output_dir (next to static/)
```

`_routes.json` lists the action prefix and the deploy inputs themselves (`_worker.js/*`, `_routes.json`, `.assetsignore`), so pages and assets are served as static files and never invoke the Worker (they stay free), and the deploy inputs are a 404 from the Worker instead of public files (the L12 security delta, N1). A request that reaches the Worker and is not an action falls through to the static files. Admission still runs in Rust (method gate, body cap, `Content-Encoding`, the cross-site guard with its 403), exactly as on Workers; see [Cloudflare](./cloudflare.md), "Static pages + actions on Pages".

`ttl_seconds`, `[cache]` and the L1 cache do not apply: pages are static files and the Worker serves actions only.
