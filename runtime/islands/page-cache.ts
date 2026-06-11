// runtime/islands/page-cache.ts — in-memory cache for SPA navigation payloads
// (/_brust/page/*) plus the fetch/dedupe machinery behind hover prefetch.
// Browser-only at call time (fetch/navigator), but import-safe anywhere.
//
// Lifetime: one document load. A full reload (dev rebuild WS, full-document
// fallback, hard refresh) drops the whole cache with the JS heap, so dev never
// serves stale pages across rebuilds.

export interface PagePayload {
  html: string
  title: string
  store?: Record<string, Record<string, unknown>>
}

/** Bound the cache so a long session can't grow memory unbounded (LRU evict). */
export const PAGE_CACHE_MAX = 64
/** Forward navigations reuse an entry for this long; back/forward (popstate)
 * passes Infinity and reuses any entry regardless of age (bfcache-like). */
export const PAGE_STALE_MS = 5 * 60_000

interface Entry {
  payload: PagePayload
  at: number
}

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<PagePayload>>()

export function pageCacheKey(url: URL): string {
  return url.pathname + url.search
}

export function getCachedPage(key: string, maxAgeMs: number = PAGE_STALE_MS): PagePayload | null {
  const e = cache.get(key)
  if (!e) return null
  if (Date.now() - e.at > maxAgeMs) {
    cache.delete(key)
    return null
  }
  // LRU bump: Map iteration order is insertion order, so re-inserting moves
  // this key to the "most recently used" end.
  cache.delete(key)
  cache.set(key, e)
  return e.payload
}

export function setCachedPage(key: string, payload: PagePayload): void {
  cache.delete(key)
  cache.set(key, { payload, at: Date.now() })
  if (cache.size > PAGE_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** Fetch a nav payload and cache it on success. Shared by navigate (direct,
 * abortable) and prefetch (deduped, signal-less). */
export async function fetchPagePayload(url: URL, signal?: AbortSignal): Promise<PagePayload> {
  const resp = await fetch(`/_brust/page${url.pathname}${url.search}`, {
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!resp.ok) throw new Error(`navigation: status ${resp.status}`)
  const payload = (await resp.json()) as PagePayload
  setCachedPage(pageCacheKey(url), payload)
  return payload
}

/** @internal — the in-flight prefetch for `key`, if any. navigate() awaits it
 * instead of double-fetching when a click lands mid-prefetch. */
export function inflightPage(key: string): Promise<PagePayload> | undefined {
  return inflight.get(key)
}

function prefetchAllowed(): boolean {
  if (typeof navigator === 'undefined') return false
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection
  if (conn?.saveData) return false
  if (typeof conn?.effectiveType === 'string' && conn.effectiveType.includes('2g')) return false
  return true
}

/** Speculatively load a page into the cache (hover/touch intent). No-op when
 * already cached fresh or when the connection asks not to (Save-Data, 2g).
 * Failures are silent — the eventual click just fetches normally. */
export function prefetchPage(url: URL): Promise<void> {
  if (!prefetchAllowed()) return Promise.resolve()
  const key = pageCacheKey(url)
  if (getCachedPage(key) !== null) return Promise.resolve()
  let p = inflight.get(key)
  if (!p) {
    p = fetchPagePayload(url).finally(() => {
      inflight.delete(key)
    })
    inflight.set(key, p)
  }
  return p.then(
    () => undefined,
    () => undefined,
  )
}

// Test-only: drop all entries and in-flight markers.
export function __resetPageCacheForTest(): void {
  cache.clear()
  inflight.clear()
}
