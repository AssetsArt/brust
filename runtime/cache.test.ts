import { afterAll, expect, mock, test } from 'bun:test'

// `mock.module` patches the module registry for the whole test worker — restore
// it so a later test importing the real ./index.js addon barrel isn't stubbed.
afterAll(() => mock.restore())

test('cache.invalidate forwards key + tags to the native bridge', async () => {
  const calls: Array<{ key: string | undefined; tags: string[] | undefined }> = []
  mock.module('./index.js', () => ({
    islandCacheInvalidate: (key?: string, tags?: string[]) => calls.push({ key, tags }),
  }))
  const { cache } = await import('./cache.ts')
  cache.invalidate({ tags: ['user_12:product'] })
  cache.invalidate({ key: 'user_12:product_5' })
  cache.invalidate({}) // both undefined → deliberate no-op on the Rust side
  expect(calls).toEqual([
    { key: undefined, tags: ['user_12:product'] },
    { key: 'user_12:product_5', tags: undefined },
    { key: undefined, tags: undefined },
  ])
})
