import { test, expect, mock } from 'bun:test'

test('cache.invalidate forwards key + tags to the native bridge', async () => {
  const calls: any[] = []
  mock.module('./index.js', () => ({
    islandCacheInvalidate: (key?: string, tags?: string[]) => calls.push({ key, tags }),
  }))
  const { cache } = await import('./cache.ts')
  cache.invalidate({ tags: ['user_12:product'] })
  cache.invalidate({ key: 'user_12:product_5' })
  expect(calls).toEqual([
    { key: undefined, tags: ['user_12:product'] },
    { key: 'user_12:product_5', tags: undefined },
  ])
})
