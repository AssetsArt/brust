// Unit tests for the SPA page-payload cache (page-cache.ts): LRU bounds,
// staleness windows, prefetch dedupe, and silent prefetch failure. No DOM
// needed — only fetch is stubbed (and restored, since bun test shares one
// process across files).
import { test, expect, afterAll, beforeEach, mock, setSystemTime } from 'bun:test'
import {
  PAGE_CACHE_MAX,
  PAGE_STALE_MS,
  pageCacheKey,
  getCachedPage,
  setCachedPage,
  fetchPagePayload,
  prefetchPage,
  inflightPage,
  __resetPageCacheForTest,
  type PagePayload,
} from './page-cache.ts'

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
  setSystemTime() // restore real clock
})

beforeEach(() => {
  __resetPageCacheForTest()
  setSystemTime()
})

const payload = (html: string): PagePayload => ({ html, title: 'T' })

function stubFetch(impl?: (url: string) => Promise<Response>) {
  const spy = mock(
    impl ??
      (async () => ({ ok: true, json: async () => payload('<p>ok</p>') }) as unknown as Response),
  )
  ;(globalThis as Record<string, unknown>).fetch = spy
  return spy
}

test('pageCacheKey is pathname+search', () => {
  expect(pageCacheKey(new URL('http://localhost/docs/a?x=1#frag'))).toBe('/docs/a?x=1')
})

test('set/get roundtrip; miss returns null', () => {
  setCachedPage('/a', payload('<p>a</p>'))
  expect(getCachedPage('/a')?.html).toBe('<p>a</p>')
  expect(getCachedPage('/missing')).toBeNull()
})

test('entries expire after PAGE_STALE_MS for forward navs, but Infinity (popstate) still hits', () => {
  setSystemTime(new Date('2026-06-12T00:00:00Z'))
  setCachedPage('/a', payload('<p>a</p>'))
  setSystemTime(new Date(Date.parse('2026-06-12T00:00:00Z') + PAGE_STALE_MS + 1))
  // Infinity first: the default-age path DELETES the expired entry.
  expect(getCachedPage('/a', Number.POSITIVE_INFINITY)?.html).toBe('<p>a</p>')
  expect(getCachedPage('/a')).toBeNull()
  // The expired-entry delete means even popstate misses afterwards.
  expect(getCachedPage('/a', Number.POSITIVE_INFINITY)).toBeNull()
})

test('LRU: exceeding PAGE_CACHE_MAX evicts the least-recently-used entry', () => {
  for (let i = 0; i < PAGE_CACHE_MAX; i++) setCachedPage(`/p${i}`, payload(`<p>${i}</p>`))
  // Touch /p0 so /p1 becomes the oldest.
  expect(getCachedPage('/p0')).not.toBeNull()
  setCachedPage('/overflow', payload('<p>over</p>'))
  expect(getCachedPage('/p1')).toBeNull()
  expect(getCachedPage('/p0')).not.toBeNull()
  expect(getCachedPage('/overflow')).not.toBeNull()
})

test('fetchPagePayload caches on success and throws on !ok without caching', async () => {
  stubFetch()
  const got = await fetchPagePayload(new URL('http://localhost/x'))
  expect(got.html).toBe('<p>ok</p>')
  expect(getCachedPage('/x')?.html).toBe('<p>ok</p>')

  stubFetch(async () => ({ ok: false, status: 500 }) as unknown as Response)
  await expect(fetchPagePayload(new URL('http://localhost/err'))).rejects.toThrow(
    'navigation: status 500',
  )
  expect(getCachedPage('/err')).toBeNull()
})

test('prefetchPage dedupes concurrent fetches for the same key', async () => {
  let release!: (r: Response) => void
  const gate = new Promise<Response>((res) => {
    release = res
  })
  const spy = stubFetch(() => gate)
  const a = prefetchPage(new URL('http://localhost/dup'))
  const b = prefetchPage(new URL('http://localhost/dup'))
  expect(inflightPage('/dup')).toBeDefined()
  expect(spy).toHaveBeenCalledTimes(1)
  release({ ok: true, json: async () => payload('<p>dup</p>') } as unknown as Response)
  await Promise.all([a, b])
  expect(getCachedPage('/dup')?.html).toBe('<p>dup</p>')
  expect(inflightPage('/dup')).toBeUndefined()
})

test('prefetchPage is a no-op when the page is already cached fresh', async () => {
  setCachedPage('/hit', payload('<p>hit</p>'))
  const spy = stubFetch()
  await prefetchPage(new URL('http://localhost/hit'))
  expect(spy).toHaveBeenCalledTimes(0)
})

test('prefetch failure is silent, leaves no cache entry, and a retry refetches', async () => {
  const spy = stubFetch(async () => ({ ok: false, status: 404 }) as unknown as Response)
  await prefetchPage(new URL('http://localhost/gone')) // resolves despite the 404
  expect(getCachedPage('/gone')).toBeNull()
  expect(inflightPage('/gone')).toBeUndefined()
  await prefetchPage(new URL('http://localhost/gone'))
  expect(spy).toHaveBeenCalledTimes(2)
})
