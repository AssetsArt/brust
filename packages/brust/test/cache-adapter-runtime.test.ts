// cache.invalidate's adapter side (afterInvalidate, L7a) and native worker 0's subscriber (R10, L3).
import { afterEach, expect, test } from 'bun:test'
import { cache } from '../src/cache'
import { memoryAdapter } from '../src/cache-adapter'
import { checkRuntime, compose, loadAdapter, resolveEnvOptions, validateAdapter } from '../src/cache-adapter/load'
import { afterInvalidate, setCacheRuntime, startSubscriber } from '../src/cache-adapter/runtime'
import type { CacheAdapter, InvalidateArgs, InvalidationEvent } from '../src/cache-adapter/types'
import { type NativeBinding, setNative } from '../src/native'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

afterEach(() => setCacheRuntime(null))

function fakeAdapter(log: string[], opts: { failPublish?: boolean; slowInvalidate?: number } = {}): CacheAdapter {
  return {
    name: 'fake',
    runtimes: ['bun'],
    store: {
      maxBodyBytes: 1,
      get: async () => ({ page: null, stamp: 0, entryStamp: null, storedAt: null }),
      set: async () => true,
      async invalidate(a) {
        log.push(`invalidate:start ${JSON.stringify(a)}`)
        await tick(opts.slowInvalidate ?? 0)
        log.push('invalidate:end')
      },
    },
    broadcast: {
      async publish(a, origin) {
        log.push(`publish ${JSON.stringify(a)} ${origin}`)
        if (opts.failPublish) throw new Error('down')
        return 1
      },
      subscribe: async () => async () => {},
    },
  }
}

test('cache.invalidate: the primitive once, then store.invalidate settles BEFORE publish (L7a)', async () => {
  const log: string[] = []
  const counted: string[] = []
  const prims: unknown[] = []
  const prev = setNative({ cacheInvalidate: (a: InvalidateArgs) => (prims.push(a), { l1Removed: 1, jobRemoved: 0 }) } as unknown as NativeBinding)
  try {
    setCacheRuntime({ adapter: fakeAdapter(log, { slowInvalidate: 30 }), origin: 'me', defer: (p) => void p, count: (n) => counted.push(n) })
    expect(cache.invalidate({ tags: ['items'] })).toEqual({ l1Removed: 1, jobRemoved: 0 })
    expect(prims).toEqual([{ tags: ['items'] }])
    await tick(80)
    expect(log).toEqual(['invalidate:start {"tags":["items"]}', 'invalidate:end', 'publish {"tags":["items"]} me'])
    expect(counted).toEqual(['published'])
  } finally {
    setNative(prev)
  }
})

test('a rejected publish counts publish_errors and leaves no unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const spy = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', spy)
  const errSpy = console.error
  console.error = () => {}
  try {
    const log: string[] = []
    const counted: string[] = []
    setCacheRuntime({ adapter: fakeAdapter(log, { failPublish: true }), origin: 'me', defer: (p) => void p.catch(() => {}), count: (n) => counted.push(n) })
    afterInvalidate({ path: '/x' })
    await tick(30)
    expect(counted).toEqual(['publish_errors'])
    expect(unhandled).toEqual([])
  } finally {
    console.error = errSpy
    process.off('unhandledRejection', spy)
  }
})

test('no runtime: afterInvalidate is a no-op', () => {
  expect(() => afterInvalidate({ tags: ['a'] })).not.toThrow()
})

function subscriberHarness() {
  const a = memoryAdapter({ broadcast: 'push' })
  const replayed: [InvalidateArgs, number][] = []
  const counted: string[] = []
  let clears = 0
  const deps = { replay: (x: InvalidateArgs, s: number) => replayed.push([x, s]), clear: () => void clears++, count: (n: string) => counted.push(n) }
  return { a, replayed, counted, deps, clears: () => clears }
}

test('L3: a replayed event is never re-published', async () => {
  const h = subscriberHarness()
  // The subscriber's process has the adapter installed as its runtime too (as worker 0 does).
  setCacheRuntime({ adapter: h.a, origin: 'me', defer: (p) => void p, count: () => {} })
  await startSubscriber(h.a, 'me', h.deps)
  await h.a.broadcast!.publish({ tags: ['items'] }, 'other')
  await tick()
  expect(h.replayed).toEqual([[{ tags: ['items'] }, 1]])
  expect(h.counted).toEqual(['received'])
  expect(h.a.__test.publishCount()).toBe(1)
})

test('own events advance the seq but are not replayed', async () => {
  const h = subscriberHarness()
  await startSubscriber(h.a, 'me', h.deps)
  await h.a.broadcast!.publish({ tags: ['a'] }, 'me')
  await h.a.broadcast!.publish({ tags: ['b'] }, 'other')
  await tick()
  expect(h.counted).toEqual(['skipped_own', 'received'])
  expect(h.replayed).toEqual([[{ tags: ['b'] }, 2]])
  expect(h.clears()).toBe(0)
})

test('a seq jump clears once then adopts; onGap clears and forgets', async () => {
  let on: ((e: InvalidationEvent) => void) | null = null
  let gap: (() => void) | null = null
  const a: CacheAdapter = {
    name: 'manual',
    runtimes: ['bun'],
    broadcast: { publish: async () => 0, subscribe: async (o, g) => ((on = o), (gap = g), async () => {}) },
  }
  const h = subscriberHarness()
  await startSubscriber(a, 'me', h.deps)
  on!({ seq: 5, origin: 'x', args: { tags: ['a'] } })
  on!({ seq: 5, origin: 'x', args: { tags: ['a'] } })
  on!({ seq: 4, origin: 'x', args: { tags: ['a'] } })
  expect(h.replayed.length).toBe(1)
  on!({ seq: 8, origin: 'x', args: { tags: ['b'] } })
  expect(h.clears()).toBe(1)
  expect(h.replayed.map(([, s]) => s)).toEqual([5, 8])
  gap!()
  expect(h.clears()).toBe(2)
  on!({ seq: 20, origin: 'x', args: { tags: ['c'] } })
  expect(h.clears()).toBe(2)
})

test('validation: shapes, runtimes, broadcast modes, env options, compose', async () => {
  expect(() => validateAdapter(null, 'x')).toThrow('not an adapter')
  expect(() => validateAdapter({ name: 'n', runtimes: ['bun'] }, 'x')).toThrow('neither a store nor a broadcast')
  expect(() => validateAdapter({ name: 'n', runtimes: ['bun'], broadcast: { publish() {} } }, 'x')).toThrow('exactly one of')
  const pull = memoryAdapter({ broadcast: 'pull' })
  expect(() => checkRuntime(pull, 'bun')).toThrow('native needs a push broadcast')
  expect(() => checkRuntime(memoryAdapter(), 'workers')).toThrow('push-only')
  expect(() => checkRuntime({ ...pull, runtimes: ['workers'] }, 'bun')).toThrow('does not run on Bun')
  expect(resolveEnvOptions({ url: 'env:R_URL', n: 1 }, { R_URL: 'redis://x' })).toEqual({ url: 'redis://x', n: 1 })
  expect(() => resolveEnvOptions({ url: 'env:NOPE' }, {})).toThrow('NOPE is not set')
  const store = memoryAdapter({ broadcast: 'none' })
  const both = compose(store, memoryAdapter({ broadcast: 'push' }))
  expect(both.store).toBe(store.store)
  expect(typeof both.broadcast?.subscribe).toBe('function')
})

test('loadAdapter: a custom factory gets its options; a built-in resolves env: options', async () => {
  const seen: unknown[] = []
  const factory = (o: Record<string, unknown>) => (seen.push(o), memoryAdapter())
  const base = { namespace: 'n', getTimeoutMs: 50, maxBodyBytes: 1, epochIntervalMs: 1000, buildId: 'b' }
  const a = await loadAdapter({ ...base, adapter: 'custom', module: 'cache-adapter.js', options: { x: 1 } }, 'bun', async (spec, builtin) => {
    expect([spec, builtin]).toEqual(['cache-adapter.js', false])
    return { default: factory }
  }, {})
  expect(a.name).toBe('memory')
  const b = await loadAdapter({ ...base, adapter: 'redis', options: { url: 'env:U' } }, 'bun', async (spec, builtin) => {
    expect([spec, builtin]).toEqual(['@brust/cache-redis', true])
    return { default: factory }
  }, { U: 'redis://h' })
  expect(b.name).toBe('memory')
  expect(seen).toEqual([{ x: 1 }, { url: 'redis://h' }])
})
