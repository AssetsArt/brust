---
title: Caching
description: The two-layer page cache — declarative L1 served from Rust with zero worker dispatch, programmatic L2 keyed from your own logic, routed per request by bypass, with tag/path invalidation.
nav: { group: "Concepts", order: 7 }
---

A route opts into response caching with a single `cache` object on the route.
It holds **two composable layers** and a per-request switch that decides which
layer serves a given request:

| | L1 — declarative | L2 — programmatic |
|---|---|---|
| Key comes from | a `prefix` **expression** (headers/cookies/query/params), evaluated in Rust | your `key(ctx)` **function**, run in the worker like a loader |
| A hit costs | **zero worker dispatch** — served straight from Rust (on `native: true` routes the Bun side is never touched) | one worker dispatch; skips the loader + render |
| Best for | public pages: per-tenant, per-locale, per-currency | personalised pages: per-user / per-group, keys derived from the DB |
| Invalidation | TTL, `cache.tags` + `cache.invalidate({ tags })`, `cache.invalidate({ path })` | TTL, `CacheKeyResult.tags` + `cache.invalidate({ tags, key })` |

`bypass` is the router between them: requests it matches fall through to L2,
everything else is served by L1.

```ts
import { defineRoutes } from 'brustjs/routes'

export const routes = defineRoutes([
  {
    path: '/pricing',
    Component: Pricing,
    native: true,
    cache: {
      ttl_seconds: 120,
      prefix: 'or(cookie(currency), "usd")', // L1: public, keyed per currency
      bypass: 'cookie(session)',              // logged-in ⇒ fall through to L2
      key: async ({ req }) => {               // L2: per-user, keyed from the DB
        const uid = req.cookies.uid
        return { key: `pricing:u:${uid}`, tags: [`user:${uid}`], ttl: 60 }
      },
    },
  },
])
```

Anonymous traffic hits L1 (one entry per currency, answered by Rust). A request
carrying a `session` cookie bypasses L1 and lands on L2, where `key()` builds a
per-user key — its entries are evicted later with
`cache.invalidate({ tags: ['user:42'] })`.

## The `cache` object

| Field | Type | Layer | Description |
|---|---|---|---|
| `ttl_seconds` | `number` | both | Base TTL in seconds. Also the L2 fallback TTL when `key_ttl_seconds`/`CacheKeyResult.ttl` are absent. |
| `prefix` | `string` | L1 | Key expression; its result becomes a distinct, collision-free field of the L1 key. |
| `bypass` | `string \| boolean` | — | The router (next section). |
| `tags` | `string[]` | L1 | Static invalidation tags carried by every L1 entry of this route. |
| `key` | `(ctx) => CacheKeyResult` | L2 | Programmatic key. Runs in the worker. **`native: true` routes only** (see Limitations). |
| `key_ttl_seconds` | `number` | L2 | Static L2 TTL; `CacheKeyResult.ttl` overrides it per entry. |

`CacheKeyResult` is `{ key: string; tags?: string[]; ttl?: number }`. `key` is
the **complete** L2 cache key — you concatenate the URL and query yourself;
nothing is auto-prepended. `ctx` is `{ req, url, params }` where `req.cookies`
is a `Record<string,string>`, `req.url` is the raw path+query string, and `url`
is a parsed `URL` (its `pathname`/`search` are real; `origin` is a placeholder).

## The `bypass` router

| `bypass` | Behaviour |
|---|---|
| absent / `false` | **L1 only** — the public declarative cache. |
| `'cookie(session)'` (expression) | **Hybrid** — non-empty result → fall through to **L2**; everything else → L1. |
| `true` | **L2 only** — every request routed to `key`. |

A bypassed request never reads from **or writes to** L1 — a personalised
response cannot leak into the shared public cache. And because L1 and L2 serve
disjoint traffic, a coarse L1 key can never shadow a finer L2 key.

A route with `bypass` but no `key` simply renders fresh on every bypassed
request (useful by itself: "logged-in users always get a live render").

## Expression grammar (L1 `prefix` / `bypass`)

Each field is **one bare expression** that evaluates to a string (`""` means
absent/false). For `bypass`, a non-empty result triggers the bypass.

**Accessors** (return the value, `""` if absent):

| Accessor | Source |
|---|---|
| `header(name)` | request header (case-insensitive) |
| `cookie(name)` | cookie value (all `Cookie` headers scanned) |
| `query(name)` | query-string parameter |
| `param(name)` | matched path parameter (e.g. `{id}`) |
| `request(field)` | `host` \| `method` \| `scheme` \| `path` |
| `env(NAME)` | environment variable (read once at boot) |

Names may be bare (`cookie(session)`) or quoted (`cookie("session")`).

**Combinators:**

| Combinator | Result |
|---|---|
| `or(a, b, …)` | the first non-empty argument |
| `and(a, b, …)` | all args joined (unit-separated) if every one is non-empty; else `""` |
| `concat(a, b, …)` | all arguments concatenated |
| `eq(a, b[, v])` | `v` (or `a`) when `a == b`; else `""` |
| `lower(x)` / `upper(x)` | ASCII case fold |

```ts
'or(cookie(currency), header(x-currency), "usd")' // first non-empty, default usd
'and(request(host), cookie(tenant))'              // host + tenant partition
'concat("v2-", lower(query(variant)))'            // literal-prefixed key
'eq(header(x-preview), "1", "preview")'           // "preview" when header is "1"
'param(id)'                                        // one L1 entry per /product/{id}
```

Expressions are compiled **once at boot**; a malformed expression, an unknown
`request()` field, or the non-deterministic `uuid()`/`timestamp()` (a key that
can never hit) **fails the route install loudly** instead of misbehaving at
request time. An empty-string expression is likewise a boot error, never a
silent no-op.

## What gets cached

A response enters either cache only when **all** of these hold:

- **Status is 200.** Errors are never cached — a transient loader/render
  failure (500) must not be replayed to every visitor for the rest of the TTL.
  Redirects and 404s also render fresh each time.
- **No `Set-Cookie` header.** A personalised response is never written to a
  shared cache.
- **Single-chunk response.** Streaming/Suspense responses are never cached.

Anything that fails these rules is still served normally — it just isn't
stored.

## Invalidation

`cache.invalidate` (from `brustjs`) evicts across **all three** caches — the
island cache, the page (L2) cache, and the L1 response cache — by exact key,
tag group, or request path:

```ts
import { cache } from 'brustjs'

// In an action / api / loader after the underlying data changes:
cache.invalidate({ tags: ['user:42'] })   // island + L2 + L1 entries carrying the tag
cache.invalidate({ key: 'pricing:u:42' }) // one exact island/L2 entry
cache.invalidate({ path: '/products' })   // every L1 entry for that path (any prefix/query)
```

L1 entries are reached two ways:

- **by tag** — declare static `cache.tags` on the route; every L1 entry the
  route produces carries them, and `cache.invalidate({ tags })` evicts the
  whole group (alongside matching island + L2 entries).
- **by path** — `cache.invalidate({ path })` (optionally `method`, default
  `GET`) evicts every L1 entry for that request path, across all prefix and
  query variants.

A route that sets neither relies on TTL expiry. The tag bookkeeping cleans up
after itself: when an entry leaves the cache (TTL, capacity eviction, or
invalidation) its tag-index entries are pruned automatically.

## Observability

- Every cache hit (either layer) carries **`X-Brust-Cache: HIT`**; a miss has
  no such header.
- `GET /_brust/cache/stats` reports L1 hits/misses/entry-count/capacity.

## Behaviour notes

- **An L1 hit skips middleware.** A hit is served at the Rust layer, before any
  worker dispatch — middleware does **not** run. If a route's middleware must
  always run (auth, logging), use `bypass` so those requests fall through to
  the render path. An L2 hit *does* run middleware (the cache is checked in the
  worker, after middleware, before the loader + render).
- Expression values are matched **verbatim** — header/cookie/query values are
  not percent-decoded.

## Tuning

Both cache capacities are operator-tunable in `brust.toml [cache]`, applied at
boot (each defaults to `1000` entries):

```toml
[cache]
max_entries = 2000        # L1 response-cache capacity
page_max_entries = 5000   # L2 page-cache capacity
```

Large cached pages × entry count dominate RSS — lower the caps to bound
memory, or raise them on a cache-heavy deployment.

## Limitations

- **L2 (`key`) applies to `native: true` routes only.** L2 capture/replay rides
  the native single-chunk fast lane; React routes render via the streaming
  channel, so a `key` on a React route is not yet honoured (the route still
  renders, just uncached by L2). L1 (`prefix`/`bypass`/`tags`) works on both
  native and React routes.
- **No `vary`.** The former `cache.vary` array is gone — `prefix` subsumes it:
  `vary: ['accept-language']` → `prefix: 'header(accept-language)'`.
- **No `${...}` interpolation.** Each field is one bare expression; use
  `concat('lit-', cookie(x))` for a literal-plus-dynamic key.
