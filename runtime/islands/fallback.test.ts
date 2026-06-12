// Unit tests for the client fallback runtime (fallback.ts): the segment
// matcher and the memoized /_brust/routes.json manifest loader. No DOM
// needed — only fetch is stubbed (and restored, since bun test shares one
// process across files). takeover()/unmountFallbackRootsIn() need a DOM and
// are covered by the ssg e2e + browser verification (Task B6 / Phase 6).
import { test, expect, afterAll, beforeEach, mock } from 'bun:test'
import {
  matchFallback,
  loadFallbackManifest,
  __resetFallbackForTest,
  type FallbackEntry,
} from './fallback.ts'

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  __resetFallbackForTest()
})

function stubFetch(impl: () => Promise<Response>) {
  const spy = mock(impl)
  ;(globalThis as Record<string, unknown>).fetch = spy
  return spy
}

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response

test('matchFallback captures decoded params; rejects length/literal mismatches', () => {
  expect(matchFallback('/blog/{slug}', '/blog/sa%20wad-dee')).toEqual({ slug: 'sa wad-dee' })
  expect(matchFallback('/d/{a}/x/{b}', '/d/1/x/2')).toEqual({ a: '1', b: '2' })
  expect(matchFallback('/blog/{slug}', '/blog')).toBeNull()
  expect(matchFallback('/blog/{slug}', '/news/x')).toBeNull()
  expect(matchFallback('/blog/{slug}', '/blog/a/b')).toBeNull()
  expect(matchFallback('/blog/{slug}', '/blog/')).toBeNull()
})

test('matchFallback: malformed percent-encoding falls back to the raw segment', () => {
  expect(matchFallback('/b/{x}', '/b/100%2')).toEqual({ x: '100%2' })
})

test('matchFallback: root and empty-segment edges', () => {
  // '/'.split('/') = ['', ''] — make sure the empty-trailing-segment shape
  // neither matches a literal nor produces an empty capture.
  expect(matchFallback('/{a}', '/')).toBeNull() // empty capture → no match
  expect(matchFallback('/', '/')).toEqual({}) // all-literal exact match
  expect(matchFallback('/', '/x')).toBeNull()
  expect(matchFallback('/x', '/')).toBeNull()
})

test('loadFallbackManifest memoizes; 404/invalid → empty list (also cached)', async () => {
  // 404 → [] and the EMPTY result is cached (one fetch for two calls): a site
  // without fallbacks must not refetch the manifest per navigation.
  const spy404 = stubFetch(async () => ({ ok: false, status: 404 }) as unknown as Response)
  expect(await loadFallbackManifest()).toEqual([])
  expect(await loadFallbackManifest()).toEqual([])
  expect(spy404).toHaveBeenCalledTimes(1)
  expect(spy404.mock.calls[0]?.[0]).toBe('/_brust/routes.json')

  // Valid manifest → entries, memoized.
  __resetFallbackForTest()
  const entry: FallbackEntry = {
    pattern: '/blog/{slug}',
    doc: '/_brust/fallback/blog/__slug__/index.html',
    payload: '/_brust/fallback-page/blog/__slug__/index.html',
    chunk: '/_brust/islands/Fallback_BlogPost_abc123.js',
  }
  const spyOk = stubFetch(async () => okJson({ version: 1, fallbacks: [entry] }))
  expect(await loadFallbackManifest()).toEqual([entry])
  expect(await loadFallbackManifest()).toEqual([entry])
  expect(spyOk).toHaveBeenCalledTimes(1)

  // fallbacks present but not an array → [].
  __resetFallbackForTest()
  stubFetch(async () => okJson({ version: 1, fallbacks: 'nope' }))
  expect(await loadFallbackManifest()).toEqual([])

  // JSON parse failure → [].
  __resetFallbackForTest()
  stubFetch(
    async () =>
      ({
        ok: true,
        json: async () => {
          throw new Error('bad json')
        },
      }) as unknown as Response,
  )
  expect(await loadFallbackManifest()).toEqual([])

  // Network-level rejection → [] (cached, not a cached rejection).
  __resetFallbackForTest()
  const spyNet = stubFetch(async () => {
    throw new TypeError('network down')
  })
  expect(await loadFallbackManifest()).toEqual([])
  expect(await loadFallbackManifest()).toEqual([])
  expect(spyNet).toHaveBeenCalledTimes(1)
})

test('loadFallbackManifest filters entries missing required string fields', async () => {
  const good: FallbackEntry = {
    pattern: '/blog/{slug}',
    doc: '/d',
    payload: '/p',
    chunk: '/c.js',
  }
  stubFetch(async () =>
    okJson({
      version: 1,
      fallbacks: [
        good,
        { pattern: '/no-chunk/{x}', doc: '/d', payload: '/p' }, // missing chunk
        { pattern: '/no-payload/{x}', doc: '/d', chunk: '/c.js' }, // missing payload
        { doc: '/d', payload: '/p', chunk: '/c.js' }, // missing pattern
        { pattern: 42, doc: '/d', payload: '/p', chunk: '/c.js' }, // non-string pattern
        null, // not even an object
        'junk',
      ],
    }),
  )
  expect(await loadFallbackManifest()).toEqual([good])
})
