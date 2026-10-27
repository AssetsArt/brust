# Actions on Elysia 2

Actions are the server endpoints your pages call: add a Pokemon to a team, save a form, read a count. In brust v2 they are **one Elysia 2 app**, served behind the Rust server. There is no `Bun.serve`, no second port, and no second router to keep in step with the first.

This page covers `@brust/core/elysia`, `@brust/core/client`, and the `[actions]` and `[cors]` sections of `brust.toml`. It targets Elysia 2 release candidates: brust supports `elysia@^2.0.0-rc.0` and `@elysia/eden@^2.0.0-rc.0` (tested with `2.0.0-rc.0`).

## 1. What actions are

```
browser -- POST /_brust/action/team --> Rust (hyper): prefix? -> preflight/CORS -> body cap -> buffer body
                                           |  one worker call (kind "fetch")
                                           v
                                     Bun worker: new Request(origin + url, ...) -> app.fetch(req)
                                        (Elysia 2, adapter brust())
                                           |  Response -> status, header pairs, body bytes
                                           v
                                     Rust: CORS stamping -> client

client code:  const api = client<App>();  await api.team.post({ id, name })   (Eden Treaty)
```

- Rust owns HTTP. Everything under the prefix goes to your app; Rust has no action router of its own.
- Your app answers 404, 422 and the other errors itself (see Errors below).
- The preflight answer, the CORS headers, the request-body cap (413) and the response-size limit (500) are implemented by the Rust server, not by your app. Your app never sees an over-cap body, and it does not need CORS code.

## 2. Setup

Actions are opt-in. Install the two packages with the `rc` tag (they are optional peers of `@brust/core`, so an app without actions installs neither):

```sh
bun add elysia@rc @elysia/eden@rc
```

Elysia 2 rc lists `typebox`, `exact-mirror` and `openapi-types` as peer dependencies. Bun installs them with the two packages; if your package manager does not install peer dependencies, add them yourself.

Add the `[actions]` table to `brust.toml`. If the table is present actions are on; if it is absent they are off, even when an `actions.ts` file exists. Every key is optional:

```toml
[actions]
entry = "actions.ts"         # project-relative path, default "actions.ts"
prefix = "/_brust/action"    # default "/_brust/action"
max_body_bytes = 1048576      # request body cap, default 1 MiB, 1..67108864
max_response_bytes = 8388608  # response body cap, default 8 MiB, 262144..67108864
cross_site = "reject"        # "reject" (default) or "allow": see Security posture
```

`brust build` bundles the entry to `dist/actions.js` (with `elysia` kept external) and records `actions { entry, prefix, maxBodyBytes, maxResponseBytes, crossSite }` in the manifest. The worker imports it at boot.

The entry must default-export an Elysia app built with the `brust()` adapter. Also export the app's type so the client can be typed from it:

```ts
// actions.ts
import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

const app = new Elysia({ adapter: brust() }).get('/hello', () => ({ hi: 'world' }))

export default app
export type App = typeof app
```

`brust()` is the web-standard adapter with the name `brust`. Its `listen` throws on purpose:

```
brust actions are served by the Rust server — remove app.listen()
```

Rust serves the app, so do not call `app.listen()`. A default export that is not an Elysia app, or one built without `brust()`, fails at worker boot with a message naming the entry. If it says two copies of elysia are installed, make `bun pm ls elysia` show one.

The prefix must start with `/`, have no trailing `/`, use only `[A-Za-z0-9._~-]` segments, and stay out of the server's own `/_brust/` paths (the default `/_brust/action` is the one allowed exception).

## 3. Routes

Elysia 2 route methods are `.get`, `.post`, `.put`, `.patch` and `.delete`. Path parameters are `:name`. **The argument order is `(path, hook, handler)`**: the hook object (schemas) comes before the handler. The Elysia 1 order `(path, handler, hook)` throws when the route is defined:

```
[Elysia] .post('/team', handler, hook) is the 1.x order; Elysia 2 takes (path, hook, handler)
```

A route with no hook takes `(path, handler)`.

```ts
// actions.ts
import { brust } from '@brust/core/elysia'
import { Elysia, problem, t } from 'elysia'

type Member = { id: string; name: string }
const MAX = 6
const team: Member[] = []

const app = new Elysia({ adapter: brust() })
  .get('/team', () => ({ team, max: MAX }))
  .post(
    '/team',
    {
      body: t.Object({ id: t.String(), name: t.String() }),
      cookie: t.Cookie({ sid: t.Optional(t.String()) }),
      headers: t.Object({ 'x-trace': t.Optional(t.String()) }),
    },
    ({ body, cookie: { sid }, set }) => {
      if (team.length >= MAX) return problem(409, { title: 'Team full', max: MAX })
      team.push(body)
      sid.value = 'seen'
      set.status = 201
      return { team, max: MAX }
    },
  )
  .delete('/team/:id', ({ params }) => {
    const i = team.findIndex((m) => m.id === params.id)
    if (i >= 0) team.splice(i, 1)
    return { team, max: MAX }
  })

export default app
export type App = typeof app
```

- **Cookies.** Declare `cookie: t.Cookie({...})` and assign `.value`. Several cookies become several `Set-Cookie` headers; they all reach the browser.
- **Headers.** `headers: t.Object({...})` validates request headers. Use lowercase names.
- **Status.** Set `set.status`, or return `status(code, value)` or `problem(code, {...})` (see Errors).
- **Per-process state.** Every worker is a separate process-level isolate with its own copy of module state. The `team` array above is for illustration. Anything that must be shared across workers and survive restarts needs its own persistence (a database file, for example).
- **Stores.** A store written inside an action is per-request. It is not snapshotted anywhere; re-read it from your persistence on the page.

## 4. Validation

Give `body`, `query` and `params` a schema. TypeBox (`t`) works, and so does any [Standard Schema](https://standardschema.dev) object (Zod, Valibot and ArkType all implement it). The handler receives typed, validated values.

```ts
// actions.ts
import { brust } from '@brust/core/elysia'
import { Elysia, t } from 'elysia'

const app = new Elysia({ adapter: brust() })
  .get(
    '/search',
    { query: t.Object({ q: t.String(), limit: t.Optional(t.Numeric()) }) },
    ({ query }) => ({ q: query.q, limit: query.limit ?? 20 }),
  )
  .put(
    '/pokemon/:id',
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ nickname: t.String({ minLength: 1, maxLength: 24 }) }),
    },
    ({ params, body }) => ({ id: params.id, nickname: body.nickname }),
  )

export default app
```

A hand-written Standard Schema object works the same way (a library schema, such as `z.object({...})`, goes in the same place):

```ts
// actions.ts
import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

const positive = {
  '~standard': {
    version: 1 as const,
    vendor: 'example',
    types: undefined as unknown as { input: unknown; output: { n: number } },
    validate: (value: unknown) =>
      typeof value === 'object' && value !== null && typeof (value as { n?: unknown }).n === 'number'
        ? { value: value as { n: number } }
        : { issues: [{ message: 'n must be a number' }] },
  },
}

const app = new Elysia({ adapter: brust() }).post('/double', { body: positive }, ({ body }) => ({
  n: body.n * 2,
}))

export default app
```

A body that fails validation answers **422** with `content-type: application/problem+json`:

```json
{
  "type": "validation",
  "code": "validation",
  "title": "Validation Error",
  "status": 422,
  "on": "body",
  "errors": []
}
```

The `errors` list, the `detail` text and the `found` and `expected` values exist only outside production. `brust start` sets `NODE_ENV=production` in every worker, so a deployed app answers just `type`, `code`, `title`, `status`, `on` and `property`. A malformed JSON body is **400** (`type: "parse"`). Bodies are parsed as JSON, text, urlencoded (a flat string record), form-data and raw bytes, by content type.

## 5. Errors

Elysia 2 rc.0 has no `.error()` method. There are three ways to produce an error, and the client sees them differently:

| How | Wire | Typed on the client |
|---|---|---|
| **Return** `problem(status, {...})` or `status(code, value)` | problem+json (`problem`) or your value (`status`) | yes: `error.status` and `error.value` are narrowed |
| **Throw** an `HTTPError.id('CODE')` subclass | RFC 9457 problem+json | no: `unknown` |
| `onError(Class, fn)` mapping a class to a response | whatever `fn` returns | no for a thrown class: `unknown` |

```ts
// actions.ts
import { brust } from '@brust/core/elysia'
import { Elysia, HTTPError, problem } from 'elysia'

// Thrown: wire problem+json {"type":"TEAM_FULL","code":"TEAM_FULL","max":6,"status":409,...}
export class TeamFull extends HTTPError.id('TEAM_FULL') {
  override readonly status = 409
  constructor(readonly max: number) {
    super('team is full')
  }
  extension() {
    return { max: this.max }
  }
}

class Legacy extends Error {
  why = 'teapot'
}

const app = new Elysia({ adapter: brust() })
  .onError(Legacy, ({ error }) => problem(418, { detail: error.why }))
  // Returned: typed on the client.
  .get('/full', () => problem(409, { title: 'Team full', max: 6 }))
  .get('/thrown', () => {
    throw new TeamFull(6)
  })
  .get('/legacy', () => {
    throw new Legacy('old')
  })

export default app
export type App = typeof app
```

Other cases:

- **Unknown path under the prefix** is a 404 `application/problem+json` (`type: "not-found"`), answered by Elysia, not the site's 404 page.
- **A wrong method under the prefix is also 404**, not 405: Elysia has no 405. Elysia adds no automatic `HEAD` or `OPTIONS` for a `GET` route either (CORS preflight is answered by Rust before your app, see CORS).
- **Outside the prefix**, a non-GET request to a page route is answered 405 by Rust.
- **An unhandled `throw new Error(...)`** is a 500 problem+json. The `detail` carries the message only outside production; in production there is no detail.

## 6. The client

`client<App>()` from `@brust/core/client` is [Eden Treaty](https://elysiajs.com) pre-wired to the actions mount. It is browser-safe: `import type { App }` is erased, so the client bundle carries no Elysia runtime (about 10 KB minified in the lane's measurement). A **value** import of the actions module in browser code would pull Elysia in (270 to 430 KB), so the build refuses it (see Limits).

```ts
// Team.ts
import { client } from '@brust/core/client'
import type { App } from './actions'

const api = client<App>()

export async function addMember(id: string, name: string) {
  const r = await api.team.post({ id, name })
  if (r.error) {
    if (r.error.status === 409) return `team full (max ${r.error.value.max})`
    return `failed with status ${r.error.status}`
  }
  return r.data
}

export async function listAndRemove(id: string) {
  const list = await api.team.get()
  await api.team({ id }).delete()
  return list.data
}
```

Options (all optional):

| Option | Meaning |
|---|---|
| `prefix` | Mount point of the actions app. Beats everything else (see The prefix). |
| `baseUrl` | Absolute `http(s)` origin of another brust deployment, or of the server when calling from the server. Required on the server: a relative URL cannot be fetched there. |
| `fetch` | The transport, a `fetch` function (this is Eden's `fetcher`). Useful for tests and for passing a `Request` straight to `app.fetch`. |
| `init` | `RequestInit` defaults for every call, for example `{ credentials: 'include' }` (this is Eden's `fetch` option). |
| `headers` | Object, or a function `(path, init) => headers`. Merged with per-call `headers`. |
| `parseDate` | Defaults to `true`: ISO date strings in JSON come back as `Date`. Set `false` to keep strings. |
| `throwHttpError` | Throw on a non-2xx instead of returning `error`. |
| `onRequest`, `onResponse` | Hooks around each call. |
| `middleware` | A list of functions between Eden and the transport, for example to renew a token and send the call again, or to add a header on every call. See Middleware. |

Eden's other options pass through. `keepDomain` is always set by the wrapper and cannot be overridden: without it Eden rewrites a relative base like `/_brust/action` to `https:///_brust/action`.

Every call resolves `{ data, error, status, response, headers }`. Exactly one of `data` and `error` is set.

| Field | Meaning |
|---|---|
| `data` | The parsed body on success, otherwise `null`. |
| `error` | `null` on success; otherwise `{ status, value }`. A **returned** `problem()`/`status()` narrows both. A thrown `HTTPError` or an `onError(Class)` response is `unknown`. |
| `status` | The HTTP status. A network failure resolves **503**, and `error.value` is the thrown error. |
| `response` | The raw `Response`. |
| `headers` | The response `Headers`. |

### Middleware

`client({ middleware })` takes a list of functions that sit between Eden and the transport. Eden has already built the request (URL, body, `headers`, `onRequest`); the chain returns the `Response` that Eden then parses, so `onResponse`, `parseDate`, `throwHttpError` and `{ data, error }` work as without it. The return type is still `Treaty.Instance<App>`: no route type changes.

```ts
type ActionMiddleware = (req: Request, next: (req: Request) => Promise<Response>) => Promise<Response> | Response
```

- **Order.** `middleware[0]` is the outermost: `[a, b]` runs `a`, then `b`, then the transport, and the response goes back through `b`, then `a`. The innermost `next` calls the `fetch` option, or global `fetch`.
- **Sending again.** `next` may be called zero, one or many times. Every `next(r)` sends its own copy of `r`: `r` is never consumed, so a retry sends the same JSON or multipart body again. If you read the body yourself (`await req.json()`), read `req.clone()` instead.
- **Answering without a request.** A link may return a `Response` without calling `next`; nothing is sent and the navigation cache is not touched.
- **Errors.** A link that throws (or rejects) is a network failure: the call resolves `status: 503` and `error.value` is the thrown error. With `throwHttpError` the call throws instead.
- **The navigation cache.** A request that goes out with a method other than `GET`/`HEAD` clears the SPA page cache once it has an answer. A retried mutation clears it twice, which is harmless.
- **URLs.** The chain works on a `Request`, so the URL must be absolute or resolvable against the page: use `baseUrl` on the server, as without a chain. With no `middleware` (or an empty list) the client is the plain transport and nothing is built.
- **Browser and server.** The same code runs in a page and in a loader. There is no global registry: make one `client<App>({ middleware })` in a module and import it.

Two recipes. A token renewal is not built in, because auth schemes differ; this one renews once for all calls that fail together (single-flight), then sends the failing call again once:

```ts
// api.ts
import { type ActionMiddleware, client } from '@brust/core/client'
import type { App } from './actions'

let renewing: Promise<boolean> | undefined
const renewSession = () =>
  (renewing ??= fetch('/_brust/action/session/refresh', { method: 'POST' })
    .then((r) => r.ok)
    .finally(() => { renewing = undefined }))

const renew: ActionMiddleware = async (req, next) => {
  const res = await next(req)
  if (res.status !== 401) return res
  return (await renewSession()) ? next(req) : res // the SAME req, sent again
}

const org: ActionMiddleware = (req, next) => {
  const r = new Request(req) // a copy to change; `req` stays unread
  r.headers.set('x-org', currentOrg())
  return next(r)
}

export const api = client<App>({ middleware: [renew, org] })
```

`renew` is outermost, so a retry goes through `org` again. Calls keep their route types: `api.team.post({ id, name })` still checks its body, and `r.error.value` still narrows on a returned `status(409, ...)`. The renewal request above uses plain `fetch`, so it does not pass through the chain and cannot loop.

### Typed routes

Types come from the chained Elysia instance, not from what a handler does at run time:

- Routes registered on an `any` app, or inside a function that does not return the chained instance, give the client no types. Write `export const auth = new Elysia().post(...)` (chained) and `app.use(auth)`, and export `typeof app`.
- A handler that returns a `Response` gives `data` an untyped body. A typed answer is a returned value plus `status(code, body)` (or `problem()`): the client then narrows `error.status` and `error.value`.
- Cookies work on a typed answer. An action may set several cookies (the `cookie` API, or `set.headers['set-cookie'] = [...]`) and return `status(401, { error: 'unauthorized' })`: every `Set-Cookie` header reaches the client, and `error.value` keeps its type.

### Differences from the 0.1.x client

The 0.1.x `runtime/treaty.ts` was a hand-made client. This one is Eden's, and its semantics are not shimmed back to the old ones:

- (a) A network failure resolves `status: 503`, with `error.value` set to the thrown error. 0.1.x resolved `status: 0`.
- (b) `headers` (and `response.headers`) is a `Headers` object. 0.1.x gave a plain `Record<string, string>`.
- (c) Path params are `encodeURIComponent`-ed: `item({ id: 'a b/c' })` requests `/item/a%20b%2Fc`, which Elysia decodes back to `a b/c`. 0.1.x used `String(v)`.
- (d) ISO date strings in JSON come back as `Date` by default; pass `parseDate: false` to keep strings. 0.1.x always returned strings.
- (e) A GET carries `content-type: application/json`, so a cross-origin GET is preflighted. 0.1.x sent none (see CORS).
- (f) Eden's `fetch` option is a `RequestInit`, and its transport is `fetcher`. This wrapper keeps the 0.1.x name: `client({ fetch })` is the transport, and the `RequestInit` moves to `init`.
- (g) New: `throwHttpError`, `onRequest`, `onResponse`, `.use(plugin)` and `middleware` (see Middleware: a plugin's hooks run before and after a call, so only `middleware` can send the call again).

Unchanged: `headers` may be a function, a `File`/`Blob` in the body switches to multipart, and the prefix order below.

On the server (a loader, a job), pass `baseUrl`. A `baseUrl` without `prefix` always means the default `/_brust/action` (the injected global exists only in the browser), so with a custom `[actions] prefix` pass `prefix` as well:

```ts
// loader.ts
import { client } from '@brust/core/client'
import type { App } from './actions'

const api = client<App>({ baseUrl: 'http://127.0.0.1:3000', prefix: '/_brust/action' }) // your [actions] prefix

export async function loadTeam() {
  const r = await api.team.get()
  return r.data?.team ?? []
}
```

## 7. The prefix

The default is `/_brust/action`. Configure it with `prefix` under `[actions]` (rules in Setup).

When the prefix is **not** the default, the server injects a script into every rendered page, next to the store tags:

```html
<script>globalThis.__BRUST_ACTION_PREFIX__="/api"</script>
```

With the default prefix nothing is injected. The client resolves its prefix in this order:

1. `opts.prefix`, if given.
2. `/_brust/action`, if `opts.baseUrl` is set (another deployment's page globals do not apply to a per-call base).
3. `globalThis.__BRUST_ACTION_PREFIX__`, if the page defined it. A base that comes from the page (`__BRUST_ACTION_BASE__`, section 11) pairs with this prefix, since both come from the same deployment's configuration.
4. `/_brust/action`.

The action app answers the **whole** prefix subtree, so a page route under the prefix would be unreachable. `brust build` refuses it:

```
route <id> (<pattern>) lies under the actions prefix <prefix>: the actions app answers every path there
```

A root `*` catch-all route is not refused. The Rust server forwards the path and query unchanged, prefix included, and the worker mounts your app under the prefix. So `request.url` inside a handler is the real URL, and your routes are written without the prefix (`/team`, not `/_brust/action/team`).

## 8. CORS

CORS is **runtime** configuration: `brust start` reads `[cors]` from `brust.toml`, so changing origins between environments needs no rebuild. Rust answers preflights (204) and stamps CORS headers on responses. Your app has no CORS code. Absent `[cors]`, CORS is off.

```toml
[cors]
origins = ["https://app.example"]   # required, non-empty; "*" allowed without credentials
methods = ["GET", "POST"]           # default GET,POST,PUT,PATCH,DELETE,OPTIONS
headers = ["content-type"]          # default: echo the request's Access-Control-Request-Headers
expose_headers = ["x-total"]        # default: none
credentials = false                 # default false
max_age_seconds = 600               # default 600
```

- `credentials = true` together with `"*"` in `origins` is a boot error (browsers reject that combination); list explicit origins. The message is `cors.credentials cannot be combined with a wildcard origin '*' ...`. An empty `origins` is also a boot error.
- The policy is **global**: it is stamped on every response the server sends, not only on actions.
- To send cookies cross-origin, point the client at the other deployment and ask for credentials:

```ts
// remote.ts
import { client } from '@brust/core/client'
import type { App } from './actions'

export const api = client<App>({
  baseUrl: 'https://api.example',
  init: { credentials: 'include' },
})
```

- Eden's GET carries `content-type: application/json`, so a cross-origin GET is preflighted (difference (e)). The default `headers` echo covers that; if you set `headers`, include `content-type`.

## 9. Security posture

**Actions are public endpoints.** Anyone who can reach the server can call them. Brust adds one default protection and nothing else; authentication and authorisation are your app's job.

**What Rust rejects by default.** A request under the actions prefix whose method is not `GET`, `HEAD` or `OPTIONS` is answered **403** before its body is read and before the worker is called, when the browser says the request is cross-site:

- `Sec-Fetch-Site: cross-site` is present, or
- an `Origin` header is present and its authority (`host[:port]`, compared as written, lower-cased) is not the request's own host. The request host is the first `X-Forwarded-Host` value when the header is present, otherwise `Host`. A literal `Origin: null` counts as foreign.

Either way the request still passes if its `Origin` is listed by name in `[cors] origins` (see CORS above). A wildcard `origins = ["*"]` does **not** count: it lets other sites read your responses, but it never switches this guard off. Use `cross_site = "allow"` for that. The response is `application/problem+json`:

```json
{"type":"about:blank","title":"CrossSiteRejected","status":403,"detail":"cross-site POST to an action is rejected; set [actions] cross_site = \"allow\", or list the exact origin in [cors].origins (a wildcard does not count)"}
```

What is **not** affected: `GET`/`HEAD` (reads are not CSRF targets), same-origin browser requests, and requests with neither header (curl, server-to-server, the Eden client running inside the worker). A sibling subdomain (`Sec-Fetch-Site: same-site`) is rejected unless its origin is listed in `[cors]`, because browsers send its `Origin` and the authority differs from the host. The 0.1.x server had no such check.

This stops a hostile web page from submitting a form to your action with the visitor's browser. It does not stop a script that sets no `Origin`, so it is not authentication.

**Behind a proxy**, make sure the original host reaches brust: either pass `Host` through or set `X-Forwarded-Host`. A proxy that rewrites `Host` and sends no `X-Forwarded-Host` makes same-origin POSTs look cross-site and they get the 403.

**Opting out.** For a public API that other sites call from a browser, set `cross_site = "allow"` in `[actions]` (usually together with `[cors]`):

```toml
[actions]
cross_site = "allow"
```

**Content type and auth stay in your app.** Elysia also parses `application/x-www-form-urlencoded` bodies, so require JSON and a token for mutations with a guard:

```ts
import { brust } from '@brust/core/elysia'
import { Elysia } from 'elysia'

const guarded = new Elysia({ adapter: brust() }).onBeforeHandle(({ request, status }) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (!request.headers.get('content-type')?.startsWith('application/json')) return status(415, 'json only')
    if (request.headers.get('authorization') !== `Bearer ${process.env.API_TOKEN}`) return status(401, 'unauthorized')
  }
})
```

The pokedex example has no auth on purpose (it is a demo); it relies on the default above.

## 10. Limits

- **Request body** at most `max_body_bytes` (default 1 MiB, up to 64 MiB). Larger is **413** `payload too large` with `Connection: close`, decided before your app runs (the server first reads and discards up to 1 MiB more of that body, for at most 2 seconds, so a client still sending gets the 413 rather than a reset; a longer body can still end in a reset); an unsupported transfer is **415**. A body of 256 KiB (262144 bytes) or less reaches the worker inline; a larger one crosses by heap transfer as raw bytes, and `await req.arrayBuffer()` returns exactly what was sent. The body is buffered whole before your app runs, so there is no streaming upload.
- **Response body** at most `max_response_bytes` (default 8 MiB, up to 64 MiB). A response that fits the 256 KiB worker slot is framed there; a larger one crosses by heap transfer with its status and every header intact. A body over `max_response_bytes` is a **500** `text/plain` with `brust: action response exceeds <max_response_bytes> bytes`, and a log line. A heap transfer that fails any other way is a **500** `brust: action failed`. Responses are buffered whole, so there is no streaming download.
- **Memory.** In-flight body memory is bounded by worker slots x (`max_body_bytes` + `max_response_bytes`): about 9 MiB per slot at the defaults, about 128 MiB per slot at the maximum caps.
- **No streaming, SSE or WebSocket** from actions in this release.
- **A string body has no `content-type`.** Elysia 2 does not add one for a plain string; return an object for JSON, or set the header yourself.
- **Stores are per-request** inside an action (see Routes).
- **Browser bundles refuse actions code.** Any browser build fails with `server-only-in-client` if it imports `@brust/core/elysia`, `elysia` or `elysia/*`, or the actions entry file. An `import type` is erased and allowed; that is why the client example imports `type { App }`.
- **Running without Rust** is not built in. If you want the app on another server, `export default app.fetch` from your own entry; the `brust()` adapter's `listen` will still throw.
- **Release candidate.** Elysia 2 is a release candidate. brust's peer range is `^2.0.0-rc.0` for both packages and its tests run on `2.0.0-rc.0`; use one copy of each (two copies of `elysia` break the `instanceof` check in `mountActions`), and re-test before moving to a later rc.

## 11. Deploy actions separately

The pages and the actions can be two deployments on two origins: static pages on Cloudflare Pages and the actions on their own domain, or an API server next to a separately hosted front end. Three settings and one build flag make that work.

**1. The actions deployment: `brust build --actions-only`.** The output has no pages: the manifest has no routes, and there are no templates, jobs or client chunks. The actions app runs behind the same Rust admission as always (method gate, body caps, `Content-Encoding`, the cross-site guard, CORS). Every path outside the prefix is a `404` `application/problem+json`. It combines with `--target bun` (the default; `brust start` serves the dist) and `--target cloudflare` (a Worker with only actions and no Static Assets, see [Cloudflare](./cloudflare.md), section 6). It cannot be combined with `--target static`. `[cache]` and route options are ignored with an info line.

In an actions-only build, and only there, `prefix = "/"` is allowed, so `https://api.example.com/team` is the app's `/team`. Your routes are still written without a prefix and `request.url` is the real URL. The server's own paths (`/ping`, `/_brust/...`, `/public/...`) stay the server's. A normal build still refuses `prefix = "/"`, because its page routes would be unreachable.

```toml
# api/brust.toml
[actions]
entry = "actions.ts"
prefix = "/"

[cors]
origins = ["https://app.example.com"]   # the exact page origin
credentials = true                      # only if the page sends cookies
```

**2. The pages deployment: `[actions] base_url`.** The page tells the browser client where the actions live:

```toml
# web/brust.toml
[actions]
base_url = "https://api.example.com"   # an absolute http(s) origin: no path, query, fragment or credentials
prefix = "/"                           # the prefix the other deployment mounts at (default /_brust/action)
credentials = "include"                # same-origin (default) | include | omit
```

`base_url` is a runtime setting, like `[cors]`: every environment points at its own API without a rebuild. Precedence: env `BRUST_ACTIONS_BASE_URL`, then `run({ config: { actionsBaseUrl } })`, then the toml. `credentials` is `run({ config: { actionsCredentials } })` or the toml. The server injects them next to the prefix script (a JSON string literal, with `<`, `>`, `&`, U+2028 and U+2029 escaped):

```html
<script>globalThis.__BRUST_ACTION_PREFIX__="/"</script><script>globalThis.__BRUST_ACTION_BASE__="https://api.example.com";globalThis.__BRUST_ACTION_CREDENTIALS__="include"</script>
```

The client resolves the base in this order: `opts.baseUrl`, the page's `__BRUST_ACTION_BASE__`, then relative. `credentials` is the default `RequestInit.credentials` of every call; `opts.init` overrides it. The typed client keeps importing `type App` from the shared source, so calls stay typed across deployments.

**A page-only build.** When `[actions]` has a `base_url` and the actions file (`actions.ts`, or `entry`) is **absent**, the build is valid: it bundles no actions, the server mounts no local app (the prefix is a page 404 locally), and the base and prefix are still injected. A missing file that `entry` names explicitly is an error, never a page-only build. With `--target static` the base is baked into the rendered pages, from the build's environment. This is how "static pages on Pages + actions on their own domain" works without the single-domain Worker of [Static output](./static.md), section 8.

**Credentials and cookies.** `credentials = "include"` only works if the actions deployment's `[cors]` lists the exact page origin (a wildcard does not count) with `credentials = true`; the cross-site guard lets a listed origin through. A cookie that must travel cross-site needs `SameSite=None; Secure`:

```ts
.post('/login', ({ cookie: { session } }) => {
  session.set({ value: token, httpOnly: true, sameSite: 'none', secure: true, path: '/' })
  return { ok: true }
})
```

Browsers treat `http://localhost` and `http://127.0.0.1` as secure for this, so it works in development. An origin that is not listed gets `403` `CrossSiteRejected` before the body is read, and the preflight of a listed origin answers `204` with the CORS headers.

## 12. Next

The pokedex example builds a team with these pieces: an Elysia app on a database file ([`examples/pokedex/actions.ts`](../examples/pokedex/actions.ts)), the typed client and the shared store ([`examples/pokedex/lib/team-client.ts`](../examples/pokedex/lib/team-client.ts)). The store is explained in [The unified store](./store.md).
