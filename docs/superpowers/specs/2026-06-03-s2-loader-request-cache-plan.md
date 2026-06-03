# Plan: S2 — loader request-scoped cache/dedupe

Spec: `2026-06-03-s2-loader-request-cache-design.md`. Branch `feat/s2-loader-request-cache`.
Baseline (parent `01dc6b6`, off main): `cd runtime && bun test` should match main's count (run it to capture). TS-only, no Rust, no napi rebuild. Gates: `bun run ci` (biome, ROOT) + `cd runtime && bun test`.

## T1 — `runtime/loader-cache.ts` + unit tests (TDD)

### Step 1a RED — `runtime/loader-cache.test.ts`
Cover: dedupe same-key concurrent → fn called once (spy); different keys → fn per key; reject →
key deleted (guarded) → re-call invokes fn again; passthrough outside scope (fn每 call, no throw);
cachedFetch GET same url concurrent → fetch once (mock global fetch), each caller reads body (clone);
cachedFetch POST → bypass (fetch every call); two separate `runInRequestCache` scopes → isolated.
Use a mockable fetch: pass via the module's `fetch` ref or `globalThis.fetch` swap with restore.

### Step 1b GREEN — `runtime/loader-cache.ts`
```ts
import { AsyncLocalStorage } from 'node:async_hooks'

const cacheCtx = new AsyncLocalStorage<Map<string, Promise<unknown>>>()

export function runInRequestCache<T>(fn: () => T): T {
  return cacheCtx.run(new Map(), fn)
}

/** Request-scoped memoize: share the in-flight promise + cache result for the
 * scope's lifetime. Outside a scope → passthrough (no cache). Reject → guarded
 * delete (identity-checked) so a stale catch can't evict a newer entry. */
export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const map = cacheCtx.getStore()
  if (!map) return fn() // passthrough — optimization, not correctness
  const existing = map.get(key)
  if (existing) return existing as Promise<T>
  const p = fn()
  map.set(key, p)
  p.catch(() => {
    if (map.get(key) === p) map.delete(key)
  })
  return p
}

/** Idempotent (GET/HEAD) fetch deduped per request. Non-idempotent → bypass.
 * Returns a fresh clone every call (the stored Response is never exposed). */
export function cachedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return fetch(url, init)
  return dedupe(`${method} ${url}`, () => fetch(url, init)).then((r) => (r as Response).clone())
}
```
Run `cd runtime && bun test loader-cache.test.ts` → green.

## T2 — wire + export

### `runtime/routes.ts`
Add `import { runInRequestCache } from './loader-cache.ts'`. Define a local helper (or inline) and
wrap the 4 `runInStoreContext` loader/render sites so cache is the OUTER scope:
replace `runInStoreContext(() => …)` with `runInRequestCache(() => runInStoreContext(() => …))` at
the native sites (`runNativeChainLoaders` calls ~`:728`, ~`:1125`) and React sites (~`:845`, ~`:1055`).
VERIFY the exact current call sites first (grep `runInStoreContext` in routes.ts) — wrap each.
Cleanest: a private `runInRequestContext(fn) = runInRequestCache(() => runInStoreContext(fn))` and
swap the 4 calls.

### `runtime/index.ts`
`export { dedupe, cachedFetch } from './loader-cache.ts'` (value; near the store exports ~778).
Do NOT export `runInRequestCache` (internal).

Run `cd runtime && bun test routes.test.ts` (no regression). `bun run ci`.

## T3 — dogfood (ergonomic)
`example/pokedex/lib/loaders.ts` `typeChartLoader`: replace the raw `fetchTypeRelations` fan-out with
`dedupe`-wrapped calls (or have `pokeapi.ts` fetchers use `cachedFetch` internally). Keep behavior
identical (18 distinct → ergonomic, no dedupe win, per spec AC4). Optionally route `fetchPokemon`/
`fetchSpecies`/`fetchEvolution` through `cachedFetch` so a future same-URL chain dedupes for free.
Drop/replace the `// GAP S2:` comment.
Verify: `bun run ci`; build pokedex (`bun run runtime/cli/index.ts build example/pokedex/index.ts`);
type-chart still renders 361 cells.

## Final verification (Phase 6)
1. `cd runtime && bun test` → no regression + new loader-cache tests.
2. `bun run ci` clean.
3. pokedex build success.
4. Read the loader-cache.ts + routes.ts wiring diff myself; confirm cache is OUTER and the
   guarded-delete identity check is present.

## BLOCKED fallback
- If a 5th loader site exists beyond the 4 (the spec notes MCP `server.ts:189` is intentionally
  unwrapped — leave it), confirm via grep `\.loader(` and `runInStoreContext`; wrap only the HTTP
  loader/render sites.
- If mocking fetch in bun is awkward, inject a fetch via a module-level overridable ref for the test.
