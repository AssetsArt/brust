# Island ISR cache — render-once SSR islands with key/tags invalidation

**Status:** spec — draft, awaiting user review
**Date:** 2026-05-31
**Branch:** TBD (`feat/island-isr-cache`)

## Goal

Today an SSR island (`ssr` on `<Island>`) calls React `renderToString` in the
Bun worker on **every request** — `runtime/islands/native-render.ts:137`, inside
`resolveIslandContext`, invoked per request from `runtime/routes.ts:598`. Bench
across the last session proved this is *the* arm/KVM jitter-bound bottleneck:
commenting the SSR island out took native-islands 3.6k → 17.5k RPS (4.9×), back
to jinja parity. `renderToString` in the worker is the same CPU-render path as
the React `/` route.

This spec lets an SSR island opt into an **ISR-style cache**: `renderToString`
runs **once per cache key**, the rendered output is frozen and stored Rust-side
(shared across the worker pool), and subsequent requests with the same key skip
`renderToString` entirely. The developer controls cache identity with a
loader-computed **key** and **tags**, and invalidates programmatically from a TS
API. This is the canonical [[napi-crossing-floor]] win applied to SSR islands:
the expensive React render leaves the per-request hot path.

Mental model: **Next.js ISR + revalidateTag, scoped to an island fragment.**

## Non-goals (this phase)

- **Page-level route cache.** Settable per-route, caches the whole route HTML.
  Acknowledged as the simpler sibling; deferred to a later phase. Shares the
  same Rust `CacheStore`.
- **Build-time prerender (SSG, original "mode 1").** Render at build, serve 100%
  Rust with no TS call. Dropped this phase — couples to the build pipeline and
  the static-props story is its own design. Add later.
- **Skipping the loader on a cache hit.** The key is derived from loader data
  (developer's choice), so the loader still runs per request. Only
  `renderToString` is cached. A request-derived key that lets a hit skip the
  loader is a future optimization, not in scope.
- **Client-only islands (`ssr:false`).** No server render to cache; untouched.
- **Beating the ~60k worker-crossing floor.** The loader crossing and SAB ship
  still happen; this removes the React render *on a hit*, not the worker visit.

## Architecture

Three layers, mirroring the existing native-island plumbing:

### 1. Compiler — capture `isr` from `<Island>`

Island authoring today (`crates/jsx-rust-compiler/src/lower.rs:451`
`lower_island`): `<Island component={Products} props={data.products}
hydrate="load" ssr />`. Spread (`{...x}`) and `id=` are rejected; unknown attrs
are ignored (forward-compatible, `lower.rs:536`).

Add one optional attribute, `isr`, parsed only when present:

```tsx
<Island
  component={Products}
  props={data.products}
  hydrate="load"
  ssr
  isr={{ key: data.cacheKey, tags: data.cacheTags, revalidate: 60 }}
/>
```

> **Authoring note for the user:** the working example we sketched used
> `<Products {...data.products} isr={…} />`, but the compiler's island form is
> `<Island component={Products} props={…} ssr isr={…} />` (spread is rejected at
> `lower.rs:481`). The `isr` design is identical either way; only the host
> element spelling differs.

`isr` is an object-literal expression container. Each sub-field is constrained
to the same shapes `island_props_path` (`lower.rs:605`) already accepts — a
destructured `Ident` or a one-deep `Member` off a destructured root — so we
reuse that extraction logic, no new evaluation model:

- `key` → `keyPath` (dotted path into loader data, e.g. `"data.cacheKey"`). Required when `isr` present.
- `tags` → `tagsPath` (dotted path resolving to a `string[]`). Optional.
- `revalidate` → `revalidate` (numeric literal, seconds; TTL). Optional.

Anything else inside `isr` (deeper chains, call expressions, computed access) →
a new `ErrorKind::IslandIsrUnsupported` at lower time, consistent with how
`props` rejects unsupported shapes. `isr` without `ssr` → error (caching a
client-only island is meaningless).

**Threading through the IR/manifest** (all parallel to the existing `propsPath`):
- `JsxNode::Island` (`lower.rs:561`) gains `key_path: Option<String>`, `tags_path: Option<String>`, `revalidate: Option<u32>`.
- `IslandMeta` + `collect_islands` (`lib.rs:92`) copy them through.
- `islands_to_json` (`lib.rs:129`) emits `keyPath`/`tagsPath`/`revalidate` (omitted when `None`, keeping back-compat for islands without `isr`).
- TS `NativeIslandEntry` (`native-render.ts:24`) gains the three optional fields.

### 2. Runtime — cache get/set around `renderToString`

In `resolveIslandContext` (`native-render.ts:109`), for an `ssr` entry that has
`keyPath`:

```
key  = pathInto(data, keyPath)            // string; if undefined → fall back to uncached render
tags = pathInto(data, tagsPath) ?? []     // string[]
hit  = cacheGet(key)                       // NAPI → Rust
  ├─ HIT  → out[island_N_html]  = hit.html
  │         out[island_N_props] = hit.props   // FROZEN PROPS — see invariant
  └─ MISS → html  = renderToString(createElement(Component, props))
            propsAttr = entityEncode(JSON.stringify(props ?? null))
            cacheSet(key, tags, ttlMs, { html, props: propsAttr })   // NAPI → Rust
            out[island_N_html]  = html
            out[island_N_props] = propsAttr
```

An `ssr` island **without** `keyPath` keeps today's exact behavior (render every
request). The existing `componentCache` (module import cache) and the
contained-failure degrade-to-empty path (`native-render.ts:140`) are unchanged;
a `renderToString` throw on a miss must NOT poison the cache (only `cacheSet` on
success).

### 3. Rust — `CacheStore` trait + moka backend

A new field on the singleton `state()` (`crates/brust/src/lib.rs`):

```rust
trait CacheStore: Send + Sync {
    fn get(&self, key: &str) -> Option<CachedIsland>;
    fn set(&self, key: &str, tags: &[String], ttl: Option<Duration>, value: CachedIsland);
    fn invalidate_key(&self, key: &str);
    fn invalidate_tags(&self, tags: &[String]);
}

struct CachedIsland { html: String, props: String }   // both already entity-/HTML-safe strings
```

`MokaStore` backs it with `moka::sync::Cache<String, CachedIsland>` plus a
tag→keys reverse index (`DashMap<String, HashSet<String>>`) so `invalidate_tags`
can evict a group. Per-entry TTL via moka's `Expiry` policy when `revalidate` is
set; entries with no `revalidate` live until explicitly invalidated. The trait
boundary is deliberate — a `RedisStore` impl can replace `MokaStore` later
without touching the runtime or NAPI surface. The store is a process-global
singleton, so it is **shared across the whole worker pool** and survives worker
restarts (it lives on the main/Rust side, not in a Bun worker).

### NAPI bridge

Three `#[napi]` functions (style per `lib.rs:293` `configure_islands_dir` —
`state()` singleton, `NapiResult`):

```rust
#[napi] fn island_cache_get(key: String) -> Option<CachedIslandJs>     // { html, props } | null
#[napi] fn island_cache_set(key: String, tags: Vec<String>, ttl_ms: Option<u32>, html: String, props: String)
#[napi] fn island_cache_invalidate(key: Option<String>, tags: Option<Vec<String>>)
```

`get`/`set` move only small strings across the boundary (the rendered fragment +
props attr) — cheap relative to the `renderToString` they replace.

### Developer invalidation API (TS)

Thin wrapper over `island_cache_invalidate`, exported from `brustjs`, callable
from any TS context (action handler, API route, loader):

```ts
import { cache } from 'brustjs'

cache.invalidate({ tags: ['user_12:product'] })   // evict a group
cache.invalidate({ key: 'user_12:product_5' })     // evict one entry
```

## Data flow (per request, native jinja route)

```
Rust → worker (routes.ts:571 native branch)
  loader(ctx) ─────────────────────────────► data           (TS, always runs)
  resolveIslandContext(manifest, data):
    for each ssr island with isr:
      key = pathInto(data, keyPath)
      island_cache_get(key) ──NAPI──► Rust MokaStore
        hit  → frozen { html, props }            (NO renderToString)  ✅
        miss → renderToString once
               island_cache_set(key, tags, ttl) ──NAPI──► Rust
  merge island_N_{html,props} into context → SAB
  napiRenderJinja ──► Rust minijinja render ──► response

elsewhere (action / api route):
  cache.invalidate({ tags }) ──NAPI──► Rust evict ──► next request misses → re-render
```

## Invariants (load-bearing)

1. **Frozen (html, props) pair.** The cached `html` and the `data-brust-props`
   attribute MUST come from the same render. On a hit we serve the cached
   `props`, NOT the live loader's island props — otherwise the client hydrates
   stale markup against fresh props → hydration mismatch. This is the whole
   reason `props` is stored alongside `html`, not recomputed.

2. **Key/props consistency on a miss.** On a miss the key and the rendered props
   both derive from the *same* loader run (`data`), so the frozen pair is
   internally consistent by construction.

3. **Opt-in, zero-overhead default.** No `isr` → byte-identical to today's path
   (no cache lookup, render every request). The cache code is reached only when
   `keyPath` is present.

4. **Miss-only TS render.** `renderToString` runs on a miss; a hit is pure
   string passthrough. A throwing render degrades to empty mount (existing
   behavior) and does NOT write the cache.

5. **SAB exclusivity / release timing untouched.** This works entirely inside
   `resolveIslandContext` (pre-SAB-write) and adds NAPI calls that return before
   the SAB write; the worker-pool claim/release invariant from
   [[napi-crossing-floor]] / the 0.1.6 split-workers work is not in this path.

## Testing

- **Compiler** (Rust unit, `lower.rs` / `lib.rs` tests): `isr` parses to
  `key_path`/`tags_path`/`revalidate`; rejects unsupported sub-field shapes;
  `isr` without `ssr` errors; `islands_to_json` golden with/without `isr`.
- **Runtime** (bun, `native-render.test.ts`): miss renders + calls `cacheSet`;
  hit skips `renderToString` and serves frozen pair; missing key falls back to
  uncached render; throwing render does not poison cache. Mock the NAPI bridge.
- **Rust store** (unit): get/set/TTL-expiry/invalidate_key/invalidate_tags;
  tag→keys reverse index correctness; trait object swap compiles.
- **Integration** (separate file per [[native-island-integration-flake]] — run
  files separately, port-race flake): two requests same key → one
  `renderToString`; invalidate by tag → next request re-renders; hydration
  byte-equality of frozen pair (no mismatch warning in console).
- **Bench (verify with eyes — [[brust-perf-bench-caveats]]):** arm RK3588,
  SSR-island route with `isr`, expect a cached hit to approach jinja parity
  (~the 4.9× headroom the isolation test showed). Reason in deltas; oha
  co-located.

## Open questions

1. **moka `sync` vs `future`.** The runtime calls are from the worker thread via
   NAPI (sync boundary) — `moka::sync::Cache` fits. Confirm no async needed.
2. **Cache size bound / eviction.** moka needs a max capacity (entry count or
   weighted by string bytes). Default? Make it a `ServeOptions.tuning` knob
   (consistent with the 0.1.6 tuning surface)?
3. **`revalidate` semantics on expiry.** Pure TTL evict (next request is a cold
   miss) vs stale-while-revalidate (serve stale, re-render in background)? SWR
   is more work and needs a background render dispatch — propose **pure TTL this
   phase**, SWR later.
4. **Cross-restart persistence.** moka is in-memory → empties on full process
   restart (not worker restart). Acceptable this phase; the `RedisStore` adapter
   is the persistence answer.
