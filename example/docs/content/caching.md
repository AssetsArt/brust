---
title: Caching
description: The two-layer page cache — declarative L1 (Rust, zero-Bun) and programmatic L2, routed per request by bypass, plus tag invalidation.
nav: { group: "Concepts", order: 7 }
---

A route opts into response caching with a single `cache` object. It holds two
composable layers and a per-request switch:

- **L1 — declarative.** Keyed by a `prefix` expression evaluated entirely in
  Rust against request headers/cookies/query. On a `native: true` route an L1
  hit is served straight from Rust — **the Bun worker is never called**.
- **L2 — programmatic.** A `key(ctx)` function (runs in the worker, like a
  loader) returns the complete cache key plus optional tags and TTL. For
  per-user / per-group pages whose key comes from your own logic or the DB.

`bypass` decides, per request, which layer applies.

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

## The `cache` object

| Field | Type | Layer | Description |
|---|---|---|---|
| `ttl_seconds` | `number` | both | Base TTL in seconds. The L2 fallback TTL when `key_ttl_seconds`/`CacheKeyResult.ttl` are absent. |
| `prefix` | `string` | L1 | Key expression; its result is prepended (as a distinct, collision-free key field). |
| `bypass` | `string \| boolean` | — | The router (see below). |
| `key` | `(ctx) => CacheKeyResult` | L2 | Programmatic key. Runs in the worker. **`native: true` routes only** (see Limitations). |
| `key_ttl_seconds` | `number` | L2 | Static L2 TTL; `CacheKeyResult.ttl` overrides it per entry. |
| `tags` | `string[]` | L1 | Static, route-level invalidation tags. L1 entries for this route carry them so `cache.invalidate({ tags })` can evict L1 (optional). |

`CacheKeyResult` is `{ key: string; tags?: string[]; ttl?: number }`. `key` is
the **complete** L2 cache key — you concatenate the URL and query yourself; no
prefix/vary is auto-applied. `ctx` is `{ req, url, params }` where `req.cookies`
is a `Record<string,string>`, `req.url` is the raw path+query string, and `url`
is a parsed `URL` (its `pathname`/`search` are real; `origin` is a placeholder).

## The `bypass` router

| `bypass` | Behaviour |
|---|---|
| absent / `false` | **L1 only** — the public declarative cache. |
| `'cookie(session)'` (expression) | **Hybrid** — anonymous → L1; a non-empty result → fall through to **L2**. |
| `true` | **L2 only** — every request routed to `key`. |

Because L1 and L2 serve disjoint traffic (partitioned by `bypass`), a coarse L1
never shadows a finer L2 — there is no key-granularity hazard.

## Expression grammar (L1 `prefix` / `bypass`)

Each field is one bare expression that evaluates to a string (`""` = absent /
false). For `bypass`, a non-empty result triggers the bypass.

**Accessors** (return the value, `""` if absent):

| Accessor | Source |
|---|---|
| `header(name)` | request header (case-insensitive) |
| `cookie(name)` | cookie value (all `Cookie` headers scanned) |
| `query(name)` | query-string parameter |
| `param(name)` | matched path parameter (e.g. `:id`) |
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
```

`uuid()` and `timestamp()` are **rejected at boot** — a non-deterministic key is
never hittable (and a non-deterministic `bypass` would silently disable the
cache). Any malformed expression or unknown `request()` field fails the route
install loudly, not at request time.

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

L1 is no longer TTL-only. It is reached two ways:

- **by tag** — declare static `cache.tags` on the route; its L1 entries carry
  those tags, and `cache.invalidate({ tags })` evicts them (alongside the
  matching island + L2 entries).
- **by path** — `cache.invalidate({ path })` (optionally `method`) evicts every
  L1 entry for that request path, regardless of `prefix` or query variant.

A route that sets neither still relies on TTL expiry for its L1 entries.

## Behaviour notes

- **An L1 hit skips middleware.** A native L1 hit is served at the Rust layer,
  before any worker dispatch — so middleware does **not** run. If a route's
  middleware must always run (auth, logging), use `bypass` so those requests
  fall through to the render path. An L2 hit *does* run middleware (the cache is
  checked in the worker, after middleware, before render).
- **`Set-Cookie` responses are never cached** (either layer) — a personalised
  response is never written to a shared cache.
- Only single-chunk responses are cached; streaming/Suspense responses are not.
- **A cache hit carries `X-Brust-Cache: HIT`** (both layers) so clients/CDNs can
  observe cache behaviour; a miss (fresh render) has no such header.

## Tuning

Both cache capacities are operator-tunable in `brust.toml [cache]`, applied at
boot (each defaults to `1000`):

- **`[cache] max_entries`** bounds the L1 response-cache entry count.
- **`[cache] page_max_entries`** bounds the L2 page-cache entry count. Large
  cached pages × 1000 entries can dominate RSS; lower it to cap memory, or raise
  it on a cache-heavy deployment.

## Limitations

- **L2 (`key`) applies to `native: true` routes only.** L2 capture/replay rides
  the native single-chunk fast lane; React routes render via the streaming
  channel, so a `key` on a React route is not yet honoured (the route still
  renders, just uncached by L2). L1 (`prefix`/`bypass`) works on both native and
  React routes.
- **No `vary`.** The former `cache.vary` array is gone — `prefix` subsumes it:
  `vary: ['accept-language']` → `prefix: 'header(accept-language)'`.
- **No `${...}` interpolation.** Each field is one bare expression; use
  `concat('lit-', cookie(x))` for a literal-plus-dynamic key.
