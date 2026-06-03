import { AsyncLocalStorage } from 'node:async_hooks'

const cacheCtx = new AsyncLocalStorage<Map<string, Promise<unknown>>>()

export function runInRequestCache<T>(fn: () => T): T {
  return cacheCtx.run(new Map(), fn)
}

/** Request-scoped memoize: share the in-flight promise + cache result for the
 * scope's lifetime. Outside a scope → passthrough. Reject → guarded delete
 * (identity-checked) so a stale catch can't evict a newer entry.
 *
 * NOTE: the reject cleanup runs one microtask after rejection, so a caller that
 * dedupes the SAME key within that gap receives the about-to-reject promise (and
 * thus the rejection) — acceptable: the result is one shared failure, not a hang. */
export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const map = cacheCtx.getStore()
  if (!map) return fn()
  const existing = map.get(key) as Promise<T> | undefined
  if (existing) return existing
  const p = fn()
  map.set(key, p)
  p.catch(() => {
    if (map.get(key) === p) map.delete(key)
  })
  return p
}

/** Idempotent (GET/HEAD) fetch deduped per request; non-idempotent → bypass.
 * Returns a fresh clone every call (the stored Response is never exposed).
 *
 * NOTE: the cache key is `method + url` ONLY — it does NOT include `init`
 * headers/body. Two `cachedFetch(sameUrl, {headers:…})` calls with DIFFERENT
 * headers in one request share the FIRST call's response. Intended for plain
 * idempotent GETs (the common loader case); if a caller varies `init` per call
 * on the same URL, use `fetch` directly. */
export function cachedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return fetch(url, init)
  // `dedupe` infers T = Response from the fetch thunk, so `r` is already Response.
  return dedupe(`${method} ${url}`, () => fetch(url, init)).then((r) => r.clone())
}
