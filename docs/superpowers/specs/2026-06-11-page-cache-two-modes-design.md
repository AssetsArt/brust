# Two-Layer Page Cache — Design Spec

**Date:** 2026-06-11
**Status:** Locked (principal-advisor reviewed; iterated with user → final)
**Touches:** Rust core (`crates/brust-core`, `crates/brust`) + Bun runtime (`runtime/`)

---

## Goal

Rework brust's page/response cache into **one `cache` config object holding two
composable layers**, with a per-request `bypass` switch deciding which layer
serves a given request:

- **L1 — declarative (Rust, zero Bun call).** Keyed by a request-driven `prefix`
  expression evaluated entirely in Rust. Serves public/anonymous traffic; a hit
  is returned straight from Rust's moka cache **without any dispatch into the Bun
  worker**. This makes `native:true` routes response-cacheable for the first time.
- **L2 — programmatic (worker).** A `key(ctx)` function runs in the Bun worker
  (loader-like) and returns `{ key, tags?, ttl? }` — the developer builds the
  full key themselves (url + query + DB-derived data). Serves personalized
  traffic (per-user / per-group). A hit skips render; it cannot skip the worker
  dispatch (Rust can't know a JS-computed key ahead of the call).

`bypass` is the **router** between layers:

| `bypass`              | behavior                                                        |
|-----------------------|----------------------------------------------------------------|
| absent / `false`      | **L1 only** — public declarative cache                         |
| `'cookie(session)'`   | **hybrid** — anonymous → L1; matched (logged-in) → **L2**      |
| `true`                | **L2 only** — every request routed to the programmatic key     |

Because L1 and L2 serve **disjoint** traffic partitioned by `bypass`, there is no
coarse-L1-shadows-fine-L2 correctness hazard.

Invalidation keeps the existing public API: `import { cache } from 'brustjs';
cache.invalidate({ key?, tags? })` now evicts from **both** the island cache
(existing) and the new page cache (L2).

## Non-goals

- **No `vary` field.** It is **removed** — `prefix` subsumes it
  (`vary: ['accept-language']` → `prefix: 'header(accept-language)'`). Existing
  usages migrated.
- **No `${...}` interpolation** in `prefix`/`bypass`; each is one bare expression.
- **No operator syntax** (`||`/`&&`); function combinators `or()`/`and()` only.
- **No non-deterministic accessors** (`uuid()`, `timestamp()`) — rejected at parse.
- **No L1 tag/key invalidation** — L1 is TTL-only (public, expires). Invalidation
  by key/tag targets L2 + islands. (Follow-up if needed.)
- **No change to React streaming/Suspense behavior** beyond the Set-Cookie
  write-back guard (a safety fix that also covers the pre-existing React path).

## API surface (`runtime/routes.ts`)

```ts
interface CacheKeyResult {
  key: string                 // the COMPLETE L2 cache key (you concat url+query)
  tags?: string[]             // groups for cache.invalidate({ tags })
  ttl?: number                // seconds; overrides key_ttl_seconds / ttl_seconds
}

interface RouteCacheConfig {
  ttl_seconds: number                          // base TTL (L1; L2 fallback)

  // L1 — declarative, evaluated in Rust (public, zero-Bun on hit)
  prefix?: string                              // key expression
  bypass?: string | boolean                    // expr | true ⇒ route to L2 (or render fresh)

  // L2 — programmatic, runs in the worker (personalized)
  key?: (ctx: { req: BrustRequest; url: URL; params: Params })
        => CacheKeyResult | Promise<CacheKeyResult>
  key_ttl_seconds?: number                     // static L2 TTL (CacheKeyResult.ttl overrides)
}

interface Route { /* …existing… */ cache?: RouteCacheConfig }   // single field
```

L2 TTL precedence: `CacheKeyResult.ttl` → `key_ttl_seconds` → `ttl_seconds`.

### Validation (in `flattenRoutes`/`defineRoutes`)

- `cache.key` present but no `cache.bypass` → **warn** (L2 unreachable: `bypass`
  never routes to it).
- `cache.key` present, `ttl` resolvable (always, via `ttl_seconds`) → ok.
- malformed `prefix`/`bypass` expression → caught at boot by Rust install (loud
  napi error), not at `defineRoutes` (TS doesn't parse the grammar).

### Examples

```tsx
// hybrid: public via L1 (0-Bun), logged-in via L2 (per-user, DB-keyed)
// NOTE: BrustRequest has `cookies: Record<string,string>` + `url: string`; the
// worker builds `ctx.url: URL` from `req.url`. There is NO `req.cookie()` method.
{
  path: '/pricing', Component: Pricing, native: true,
  cache: {
    ttl_seconds: 120,
    prefix: 'or(cookie(currency), "usd")',
    bypass: 'cookie(session)',
    key: async ({ req }) => {
      const uid = req.cookies.uid                  // Record access, not a method
      return { key: `pricing:u:${uid}`, tags: [`user:${uid}`], ttl: 60 }
    },
  },
}

// pure L1 (public)
cache: { ttl_seconds: 60, prefix: 'cookie(tenant)' }

// pure L2 (everyone programmatic)
cache: {
  ttl_seconds: 45, bypass: true,
  key: ({ url }) => ({ key: `s:${url.pathname}${url.search}` }),  // url is a URL
}
```

## Expression grammar (L1 `prefix` / `bypass`)

Bare expression; evaluates to a `String` (`""` = absent/false). EBNF:

```
expr     := call | accessor | literal
call      := ident '(' [ arg { ',' arg } ] ')'
accessor  := ('header'|'cookie'|'query'|'param'|'request'|'env') '(' string ')'
literal   := "'" chars "'" | '"' chars '"'
```

| Accessor          | Source (case-insensitive header lookup; `cookie` scans all `Cookie` headers) |
|-------------------|------------------------------------------------------------------------------|
| `header(name)`    | request header                                                               |
| `cookie(name)`    | cookie value                                                                 |
| `query(name)`     | query-string param                                                           |
| `param(name)`     | matched path param                                                           |
| `request(field)`  | `path` \| `method` \| `host` \| `scheme`                                     |
| `env(NAME)`       | env var (read once at boot, frozen)                                          |

| Combinator        | Semantics                                                                    |
|-------------------|------------------------------------------------------------------------------|
| `or(a, b, …)`     | first non-empty arg; `""` if all empty                                       |
| `and(a, b, …)`    | all args non-empty → joined by `\x1f` (unit sep, can't appear in HTTP values); else `""` |
| `concat(a, b, …)` | args concatenated, no separator                                              |
| `eq(a, b[, v])`   | `v` (or `a`) when `a == b`; else `""`                                        |
| `lower(x)`/`upper(x)` | ASCII case fold                                                          |

**Rejected at parse (boot error):** `uuid`, `timestamp`, unknown idents, arity
violations, empty `or()`/`and()`, unbalanced parens.

**Per-field semantics:**
- `bypass`: result non-empty ⇒ route to L2 (or render fresh if no `key`). `true`
  ⇒ always; absent/`false` ⇒ never. Implementation: when bypassing, Rust sets the
  dispatch envelope flag `bypassed=true` and skips the L1 key entirely (no read,
  no write).
- `prefix`: result becomes a **dedicated field of the L1 `CacheKey`** (not concat
  into `path`), so it cannot collide across field boundaries.

## Architecture

```
request ─▶ handle_request (Rust)
   bypass eval (true | expr non-empty)?
     YES → dispatch worker, envelope.bypassed = true       (no L1 read/write)
              worker: cache.key present?
                 yes → { key,tags,ttl } = await key(ctx)
                       page_cache_get(key)?  hit → replay payload (skip render)
                                             miss → render → page_cache_set(key,tags,ttl,payload)
                 no  → render fresh (no cache)
     NO  → L1 key = CacheKey{ prefix(eval), method, path, sorted_query }
              response_cache.get(key)?  hit → framed bytes, ZERO worker dispatch
                                        miss → dispatch (native: single_chunk | react: streaming)
                                               with CacheWriteback(L1 key, ttl)
   write-back (L1 or L2) skipped if response meta headers contain `set-cookie`.
```

Two moka instances in the Rust addon singleton (both `CacheStore`-style, future
Redis-swappable):
- `ResponseCache` (existing, extended) — L1, structured `CacheKey`, framed bytes.
- `PageCache` (new) — L2, free string key + `tag_index`, stores the **framed
  single-chunk SAB payload** `[meta_len: u16 BE][meta JSON][body]` (the exact
  bytes `napi_render_jinja` / `packSingleChunkResponse` already produce). meta
  carries `{ status, contentType, headers, streaming:false }`, so a cached 200
  never masks a 404 and redirects survive. **Not** HTML-only.

### L2 capture/replay (resolves the spec-review "hard part")

The native render path writes the framed payload INTO the SAB slot and returns
its length; the worker holds `slotView` over that slot. So the worker can
capture and replay without any napi change:

- **MISS:** run the existing render (native fast-lane `napiRenderJinja` or React
  `packSingleChunkResponse`) → it returns `len` and the framed bytes sit at
  `slotView[0..len]`. Read `slotView.subarray(0, len)` as the payload, parse its
  meta (skip the store if headers contain `set-cookie`), `pageCacheSet(key, tags,
  ttlMs, payload)`, return `len`.
- **HIT:** write the cached payload into `slotView`, return its length — the same
  fast-lane Rust reads on a normal native render. Skips loader+render entirely.

Only **single-chunk** responses are L2-cacheable (native is always single-chunk;
React only when non-streaming) — identical to the existing L1 single-chunk-only
rule. Streaming/Suspense responses are never L2-cached.

> The L2 hook wraps the render branches in `makeRenderer`: an early
> `pageCacheGet`→replay at the top (after middleware, before
> `buildRenderElement`), and a `pageCacheSet` after the render branch returns
> `len`. Extract a small "render-to-SAB → len" seam so both the native and React
> branches funnel through one capture point.

## File structure

```
crates/brust-core/src/cache/
  key_expr.rs        (new)  — expression parser + evaluator (pure, unit-tested)
  page_cache.rs      (new)  — PageCache moka store + tag_index (mirrors island_cache)
  response_cache.rs  (edit) — CacheKey.prefix; CacheConfig.prefix/bypass
  island_cache.rs    (—)    — unchanged (precedent for page_cache)
  mod.rs             (edit) — expose key_expr + page_cache
crates/brust-core/src/routing/routes.rs   (edit) — RouteConfig cache fields; store compiled KeyExpr in a parallel Vec in RouteTable (NOT re-parsed per request; CacheConfig stays Deserialize-only); BypassSpec; RouteEnvelope.bypassed
crates/brust-core/src/server/mod.rs       (edit) — bypass/prefix eval before lookup; ADD `writeback: Option<CacheWriteback>` param to dispatch_single_chunk (thread None at the action + SSE/WS/mcp callers, Some(L1) at the native render caller); set-cookie guard after decode_fast_lane, before insert; bypassed in the dispatched envelope
crates/brust-core/src/config.rs           (edit) — wire PageCache into AppState (get/set/invalidate_key/invalidate_tags/clear) + construction
crates/brust/src/lib.rs                    (edit) — page_cache_get/set/invalidate/clear napi (Buffer in/out, ttl_ms like island_cache)
runtime/
  routes.ts          (edit) — RouteCacheConfig (drop vary; add prefix/bypass/key/key_ttl_seconds); CacheKeyResult; RouteCall 'render' gains `bypassed`; **REMOVE the `native:true` + `cache` rejection (validateRoute ~424)** — native is now the primary L1 target; warn on key-without-bypass; worker L2 capture/replay in makeRenderer
  index.ts           (edit) — serialize ONLY {ttl_seconds,prefix,bypass} to registerRoutes (strip the `key` FUNCTION before JSON.stringify); page-cache napi bindings
  cache.ts           (edit) — invalidate fans out to islandCacheInvalidate + pageCacheInvalidate
  islands/isr-jsx.ts (—)    — IsrConfig is the shape precedent for CacheKeyResult
# vary migration is a NO-OP: rg finds zero `vary:` usages in example/ or docs/.
# Only deletions: the routes.ts type field, the Rust CacheConfig field, and the
# server/mod.rs test `build_cache_key_sorts_query_and_uses_vary` (rewrite for prefix).
```

## napi seam (mirrors `island_cache_*`)

```rust
#[napi] pub fn page_cache_get(key: String) -> Option<Buffer>
#[napi] pub fn page_cache_set(key: String, tags: Vec<String>, ttl_ms: Option<u32>, payload: Buffer)
#[napi] pub fn page_cache_invalidate(key: Option<String>, tags: Option<Vec<String>>)
#[napi] pub fn page_cache_clear()
```

L1 (`prefix`/`bypass`) crosses napi inside `RouteConfig.cache` JSON
(`{ ttl_seconds, prefix?, bypass? }`; `bypass` serializes as bool `true` or a
string expr — serde `#[serde(untagged)]` `enum BypassSpec { Always(bool),
Expr(String) }`). `key`/`key_ttl_seconds` stay TS-side (function — not
serialized); the worker reads them off the FlatRoute.

## Invalidation

`runtime/cache.ts` — unchanged signature, fans out:

```ts
export const cache = {
  invalidate(args: InvalidateArgs): void {
    ;(native as any).islandCacheInvalidate?.(args.key, args.tags)
    ;(native as any).pageCacheInvalidate?.(args.key, args.tags)   // NEW
  },
}
```

`PageCache` mirrors `island_cache.rs`: `tag_index: Mutex<HashMap<String,
HashSet<String>>>`, **index tags before the moka insert** (panic-race tolerance,
load-bearing ordering per the island-cache comment), `invalidate_tags` collects
keys under the lock then drops it before touching moka.

## Behavior / concurrency invariants

- **Disjoint layers:** `bypass` partitions traffic — L1 (public) and L2
  (personalized) never serve the same request; no shadowing hazard.
- **Determinism:** L1 expressions are request-deterministic; `uuid`/`timestamp`
  rejected at parse (a non-det prefix is unhittable; a non-det bypass disables L1).
- **Bypass is total:** truthy bypass ⇒ no L1 read **and** no L1 write.
- **Prefix isolation:** structured key field, collision-free.
- **Set-Cookie never cached:** neither layer writes back a `set-cookie` response
  (new native path + pre-existing React path).
- **Process-global, cross-worker:** both moka caches live in the addon singleton,
  shared across worker isolates (a per-isolate JS Map was rejected: divides hit
  rate, unbounded, no TTL).
- **L1 hit skips middleware** (served at the Rust layer) — documented; use
  `bypass` for routes whose middleware must always run.
- **L2 hit runs middleware, skips loader+render** (cache checked in the worker,
  after middleware).
- **No latency regression:** uncached routes pay nothing; L1 hits never dispatch;
  L1 miss adds one framed-bytes build + moka insert; action path threads
  `writeback: None` (actions never cached).

## Tests

**Rust (cargo):**
- `key_expr`: each accessor; `or`/`and`/`concat`/`eq`/`lower`/`upper`; nesting;
  quoting; whitespace. Rejects `uuid`/`timestamp`/unknown/bad-arity/empty-combinator/
  unbalanced. Eval: `or` first-non-empty; `and` all-or-empty with `\x1f`;
  `cookie()` across multiple Cookie headers; case-insensitive `header()`.
- `response_cache`: `prefix` differentiates keys; collision pair
  (`prefix="ten"` vs `"tenant"`) distinct.
- `page_cache`: get/set round-trip; tag invalidate evicts all keys for a tag;
  key invalidate evicts one; lazy TTL expiry; set-before-index ordering.
- `server`: bypass truthy ⇒ no L1 read/write + `bypassed` flag set; native route
  miss writes back, second request hits with **no dispatch** (assert dispatch
  counter); write-back skipped on `set-cookie`.

**TS (bun test, real addon):**
- `defineRoutes` warns on `key` without `bypass`.
- `cache` serializes `{ ttl_seconds, prefix, bypass }` only (no function).
- `page_cache_get/set` round-trips a payload (status/headers/content-type survive,
  not HTML-only); `set` skipped when payload headers contain `set-cookie`.
- `cache.invalidate({ tags })` evicts page-cache entries (round-trip via addon).
- removed `vary` no longer referenced anywhere (`rg vary` in runtime returns 0).

**Integration/browser:**
- a `native:true` hybrid route: anonymous served from L1 (0-Bun, distinct per
  `prefix`); logged-in (`bypass` cookie) served from L2 per-user key;
  `cache.invalidate({ tags:['user:123'] })` forces a fresh L2 render.

## Acceptance criteria

1. `native:true` route + `cache` serves L1 hits from Rust with **no worker dispatch**.
2. `bypass` routes per-request: false→L1, expr-match/`true`→L2, no-`key`→render fresh.
3. `prefix` partitions the L1 key, collision-free; `vary` is gone, migrated to `prefix`.
4. Grammar supports the documented accessors+combinators; rejects `uuid`/`timestamp`/malformed at boot.
5. L2 `key` returns `{ key, tags?, ttl? }`; entries cache from the worker, skip render on hit, store full meta+body.
6. `cache.invalidate({ key, tags })` evicts BOTH island and page caches (existing API unchanged).
7. No `set-cookie` response written to either cache.
8. React response-cache + native fast-path otherwise unchanged; full cargo+bun baseline green; `.node` rebuilt.
9. Docs page covers both layers, the `bypass` router, the grammar, invalidation, and the L1-skips-middleware caveat.

## Known limitations

- Bare expressions, no `${...}` (one-way-safe to add later).
- L2 always pays one napi hop on a hit (use L1 for zero-Bun).
- `and()`/`or()` only; `||`/`&&` could later desugar (out of scope).
- `env()` frozen at boot.
- L1 is TTL-only (no key/tag invalidation); invalidation targets L2 + islands.
- Naming: `ttl_seconds`/`prefix`/`bypass`/`key`/`key_ttl_seconds` mix snake_case
  with a camelCase-free surface; `key` is a function, the rest serialize. Accepted.

## Open questions — resolved

- Syntax → function grammar (`or`/`and`); bare, not `${}`.
- Modes → **composable in one `cache` object**, `bypass` routes between L1/L2
  (not mutually exclusive).
- L2 key → returns **object** `{ key, tags?, ttl? }` (was string).
- Invalidation → existing `cache.invalidate` fans out to the new page cache; L2
  carries tags via the island-cache tag-index pattern.
- `vary` → **removed**, folded into `prefix`.
- Storage → separate `PageCache` moka, payload = meta+body bytes.
- Set-Cookie → hard-skip write-back both layers + warn.
