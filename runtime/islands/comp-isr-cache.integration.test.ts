// Component-ISR cache integration — exercises resolveComponentContext against
// the REAL Rust-backed NAPI cache (not a fake), proving:
//   1. two requests with the same key render the factory ONCE (second is a hit),
//   2. tag invalidation forces a re-render,
//   3. distinct keys cache independently.
//
// In-process (no HTTP server → no port-race flake; cf. memory
// native-island-integration-flake). Requires the built ./index.js addon; the
// four island_cache_* NAPI fns must exist (shared keyspace with islands).
import { beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as native from '../index.js'
import {
  type IslandCache,
  type NativeComponentEntry,
  loadComponentManifest,
  resolveComponentContext,
} from './native-render.ts'
import { renderCounter } from './__fixtures__/render-counter.ts'

const COUNTING_PATH = path.resolve(import.meta.dir, '__fixtures__/CountingComp.tsx')

// Real adapter, identical shape to the one routes.ts wires into the request path.
const cache: IslandCache = {
  get(key) {
    return (native as any).islandCacheGet?.(key) ?? null
  },
  set(key, tags, ttlMs, html, props) {
    ;(native as any).islandCacheSet?.(key, tags, ttlMs, html, props)
  },
}

let dir: string
let manifest: NativeComponentEntry[]

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'brust-comp-isr-int-'))
  const reactPath = require.resolve('react')
  writeFileSync(
    path.join(dir, 'IsrComp.factory.ts'),
    `import { createElement as h } from ${JSON.stringify(reactPath)}
import CountingComp from ${JSON.stringify(COUNTING_PATH)}
export const factories: Array<(ctx: any) => any> = [
  (ctx: any) => h(CountingComp, { n: ctx.counter.n }),
]`,
  )
  writeFileSync(
    path.join(dir, 'IsrComp.components.json'),
    JSON.stringify([
      {
        component: 'CountingComp',
        instance: 0,
        sourcePath: COUNTING_PATH,
        keyPath: 'cacheKey',
        tagsPath: 'cacheTags',
      },
    ]),
  )
  manifest = loadComponentManifest('IsrComp', dir)!
  expect(manifest).not.toBeNull()
})

beforeEach(() => {
  ;(native as any).islandCacheClear()
  renderCounter.count = 0
})

test('two requests with the same key render the factory once (real Rust cache hit)', async () => {
  const data = { counter: { n: 7 }, cacheKey: 'layout:7', cacheTags: ['layout'] }

  const first = await resolveComponentContext(manifest, data, 'IsrComp', dir, cache)
  expect(renderCounter.count).toBe(1)
  expect(first.comp_0_html).toBe('<span>7</span>')

  // Same key, MUTATED live data — must serve the frozen html, not re-render.
  const second = await resolveComponentContext(
    manifest,
    { ...data, counter: { n: 999 } },
    'IsrComp',
    dir,
    cache,
  )
  expect(renderCounter.count).toBe(1) // no second render → cache hit
  expect(second.comp_0_html).toBe('<span>7</span>') // frozen, not <span>999</span>
  // Components have no hydration props slot (unlike islands' island_N_props):
  // a hit must serve only comp_N_html, never a comp_N_props key.
  expect(second).not.toHaveProperty('comp_0_props')
})

test('tag invalidation forces a re-render on the next request', async () => {
  const data = { counter: { n: 7 }, cacheKey: 'layout:7', cacheTags: ['layout'] }

  await resolveComponentContext(manifest, data, 'IsrComp', dir, cache)
  expect(renderCounter.count).toBe(1)

  ;(native as any).islandCacheInvalidate(undefined, ['layout'])

  const reRendered = await resolveComponentContext(manifest, data, 'IsrComp', dir, cache)
  expect(renderCounter.count).toBe(2) // invalidated → re-rendered
  expect(reRendered.comp_0_html).toBe('<span>7</span>') // same input → same html
})

test('distinct keys cache independently', async () => {
  const mk = (n: number) => ({ counter: { n }, cacheKey: `layout:${n}`, cacheTags: ['layout'] })

  await resolveComponentContext(manifest, mk(1), 'IsrComp', dir, cache)
  await resolveComponentContext(manifest, mk(2), 'IsrComp', dir, cache)
  expect(renderCounter.count).toBe(2) // two distinct keys → two renders

  await resolveComponentContext(manifest, mk(1), 'IsrComp', dir, cache) // hit
  await resolveComponentContext(manifest, mk(2), 'IsrComp', dir, cache) // hit
  expect(renderCounter.count).toBe(2) // both served from cache
})
