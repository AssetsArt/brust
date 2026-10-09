import { expect, test } from 'bun:test'
import { cache } from '../src/cache'
import { type NativeBinding, setNative } from '../src/native'

test('cache() is identity; cache.invalidate needs a running server and forwards to the addon', () => {
  const C = () => null
  const opts = { key: (p: { id: string }) => p.id, tags: () => ['items'], revalidate: 60 }
  expect(cache(C, opts)).toBe(C)
  expect((C as unknown as { __brustCache: unknown }).__brustCache).toBe(opts)

  const calls: unknown[] = []
  const fake = {
    cacheInvalidate(args: unknown) {
      calls.push(args)
      if (calls.length === 1) throw new Error('startServer has not been called')
      return { l1Removed: 2, jobRemoved: 1 }
    },
  } as unknown as NativeBinding
  const prev = setNative(fake)
  try {
    expect(() => cache.invalidate({ tags: ['items'] })).toThrow('cache.invalidate needs a running server')
    expect(cache.invalidate({ path: '/items/7', method: 'GET' })).toEqual({ l1Removed: 2, jobRemoved: 1 })
    expect(calls).toEqual([{ tags: ['items'] }, { path: '/items/7', method: 'GET' }])
  } finally {
    setNative(prev)
  }
})
