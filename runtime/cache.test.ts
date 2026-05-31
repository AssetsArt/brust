// Exercises the dev-facing cache.invalidate API against the REAL Rust NAPI
// addon (no mock.module — a module mock of ./index.js leaks across the whole
// test worker and breaks unrelated tests that import the native barrel, since
// Bun's mock.restore() does not undo mock.module). Requires the built addon
// (`bun run build:debug`).
import { beforeEach, expect, test } from 'bun:test'
import { cache } from './cache.ts'
import * as native from './index.js'

beforeEach(() => {
  ;(native as any).islandCacheClear()
})

test('invalidate({ tags }) evicts every key carrying a tag', () => {
  ;(native as any).islandCacheSet('a', ['grp'], undefined, '<a/>', '{}')
  ;(native as any).islandCacheSet('b', ['grp'], undefined, '<b/>', '{}')
  ;(native as any).islandCacheSet('c', ['other'], undefined, '<c/>', '{}')

  cache.invalidate({ tags: ['grp'] })

  expect((native as any).islandCacheGet('a')).toBeNull()
  expect((native as any).islandCacheGet('b')).toBeNull()
  expect((native as any).islandCacheGet('c')).not.toBeNull() // untagged group survives
})

test('invalidate({ key }) evicts exactly one entry', () => {
  ;(native as any).islandCacheSet('k1', [], undefined, '<x/>', '{}')
  ;(native as any).islandCacheSet('k2', [], undefined, '<y/>', '{}')

  cache.invalidate({ key: 'k1' })

  expect((native as any).islandCacheGet('k1')).toBeNull()
  expect((native as any).islandCacheGet('k2')).not.toBeNull()
})

test('invalidate({}) is a no-op (evicts nothing)', () => {
  ;(native as any).islandCacheSet('k', ['t'], undefined, '<z/>', '{}')
  cache.invalidate({})
  expect((native as any).islandCacheGet('k')).not.toBeNull()
})
