// ISR cache integration — exercises resolveIslandContext against the REAL
// Rust-backed NAPI cache (not a fake), proving:
//   1. two requests with the same key renderToString ONCE (second is a hit),
//   2. tag invalidation forces a re-render,
//   3. the served (html, props) pair is byte-stable across a hit (hydration-safe).
//
// In-process (no HTTP server → no port-race flake; cf. memory
// native-island-integration-flake). Requires the built ./index.js addon
// (`bun run build:debug`); the four island_cache_* NAPI fns must exist.
import { beforeEach, expect, test } from 'bun:test'
import path from 'node:path'
import * as native from '../index.js'
import { type IslandCache, type NativeIslandEntry, resolveIslandContext } from './native-render.ts'
import { renderCounter } from './__fixtures__/render-counter.ts'

const COUNTING_PATH = path.resolve(import.meta.dir, '__fixtures__/CountingIsland.tsx')

// Real adapter, identical shape to the one routes.ts wires into the request path.
const cache: IslandCache = {
  get(key) {
    return (native as any).islandCacheGet?.(key) ?? null
  },
  set(key, tags, ttlMs, html, props) {
    ;(native as any).islandCacheSet?.(key, tags, ttlMs, html, props)
  },
}

const entry: NativeIslandEntry = {
  component: 'CountingIsland',
  instance: 0,
  propsPath: 'counter',
  ssr: true,
  hydrate: 'load',
  sourcePath: COUNTING_PATH,
  keyPath: 'cacheKey',
  tagsPath: 'cacheTags',
}

beforeEach(() => {
  ;(native as any).islandCacheClear()
  renderCounter.count = 0
})

test('two requests with the same key renderToString once (real Rust cache hit)', async () => {
  const data = { counter: { n: 7 }, cacheKey: 'product:7', cacheTags: ['product'] }

  const first = await resolveIslandContext([entry], data, cache)
  expect(renderCounter.count).toBe(1)
  expect(first.island_0_html).toBe('<span>7</span>')

  // Same key, MUTATED live props — must serve the frozen pair, not re-render.
  const second = await resolveIslandContext([entry], { ...data, counter: { n: 999 } }, cache)
  expect(renderCounter.count).toBe(1) // no second render → cache hit
  expect(second.island_0_html).toBe('<span>7</span>') // frozen html, not <span>999</span>
  expect(second.island_0_props).toBe(first.island_0_props) // byte-stable → hydration-safe
})

test('tag invalidation forces a re-render on the next request', async () => {
  const data = { counter: { n: 7 }, cacheKey: 'product:7', cacheTags: ['product'] }

  await resolveIslandContext([entry], data, cache)
  expect(renderCounter.count).toBe(1)

  ;(native as any).islandCacheInvalidate(undefined, ['product'])

  await resolveIslandContext([entry], data, cache)
  expect(renderCounter.count).toBe(2) // invalidated → re-rendered
})

test('distinct keys cache independently', async () => {
  const mk = (n: number) => ({ counter: { n }, cacheKey: `product:${n}`, cacheTags: ['product'] })

  await resolveIslandContext([entry], mk(1), cache)
  await resolveIslandContext([entry], mk(2), cache)
  expect(renderCounter.count).toBe(2) // two distinct keys → two renders

  await resolveIslandContext([entry], mk(1), cache) // hit
  await resolveIslandContext([entry], mk(2), cache) // hit
  expect(renderCounter.count).toBe(2) // both served from cache
})
