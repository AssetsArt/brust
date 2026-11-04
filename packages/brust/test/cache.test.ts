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

test('F493: cache.invalidate forwards prefix; refuses prefix with key and a non-string prefix before the addon', () => {
  const calls: unknown[] = []
  const fake = {
    cacheInvalidate(args: unknown) {
      calls.push(args)
      return { l1Removed: 1, jobRemoved: 0 }
    },
  } as unknown as NativeBinding
  const prev = setNative(fake)
  try {
    expect(cache.invalidate({ prefix: 'a.test', path: '/about' })).toEqual({ l1Removed: 1, jobRemoved: 0 })
    expect(cache.invalidate({ prefix: '', tags: ['page'] })).toEqual({ l1Removed: 1, jobRemoved: 0 })
    expect(cache.invalidate({ prefix: 'a.test' })).toEqual({ l1Removed: 1, jobRemoved: 0 })
    expect(() => cache.invalidate({ prefix: 'a.test', key: 'k' })).toThrow(
      new TypeError('cache.invalidate: `prefix` narrows page entries; `key` names a job entry — call them separately'),
    )
    expect(() => cache.invalidate({ prefix: 7 as unknown as string })).toThrow(TypeError)
    expect(() => cache.invalidate({ prefix: null as unknown as string, path: '/x' })).toThrow('`prefix` must be a string')
    expect(calls).toEqual([{ prefix: 'a.test', path: '/about' }, { prefix: '', tags: ['page'] }, { prefix: 'a.test' }])
  } finally {
    setNative(prev)
  }
})
