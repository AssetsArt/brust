import { afterEach, expect, test } from 'bun:test'
;(globalThis as any).location ??= { href: 'http://localhost/' }
import { __resetNavForTest, registerNavigator } from './store.ts'
import { buildSearch, navigate } from './navigate.ts'
afterEach(() => __resetNavForTest())
test('buildSearch: empty → "", coercion, arrays, null/undefined skip, empty array', () => {
  expect(buildSearch({})).toBe('')
  expect(buildSearch({ a: 1, b: true, c: 'x' })).toBe('?a=1&b=true&c=x')
  expect(buildSearch({ t: ['fire', 'water'] })).toBe('?t=fire&t=water')
  expect(buildSearch({ a: null, b: undefined, c: 'y' })).toBe('?c=y')
  expect(buildSearch({ a: [] })).toBe('')
})
test('navigate: calls registered navigator with built URL + replace flag', async () => {
  const calls: Array<{ url: string; replace: boolean }> = []
  registerNavigator(async (url, replace) => {
    calls.push({ url: url.pathname + url.search, replace })
  })
  await navigate('/search', { query: { q: 'pikachu', page: 2 }, replace: true })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.replace).toBe(true)
  const u = new URL('http://x' + calls[0]!.url)
  expect(u.pathname).toBe('/search')
  expect(u.searchParams.get('q')).toBe('pikachu')
  expect(u.searchParams.get('page')).toBe('2')
})
test('navigate: option query MERGES over an existing path query (replace key, keep others)', async () => {
  let got: URL | undefined
  registerNavigator(async (url) => {
    got = url
  })
  await navigate('/x?a=1&b=2', { query: { a: 9 } })
  expect(got!.searchParams.get('a')).toBe('9')
  expect(got!.searchParams.get('b')).toBe('2')
})
test('navigate: null option value deletes an existing path query key', async () => {
  let got: URL | undefined
  registerNavigator(async (url) => {
    got = url
  })
  await navigate('/x?a=1', { query: { a: null } })
  expect(got!.searchParams.has('a')).toBe(false)
})
