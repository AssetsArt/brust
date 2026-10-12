import { describe, expect, test } from 'bun:test'
import { doAdapter, shardIndex } from '../src/do-adapter'
import { fakeDoEnv } from './fakes'

const init = { namespace: 'ns', buildId: 'b', runtime: 'workers' as const, workerId: 0 }
const mk = (opts = {}) => {
  const f = fakeDoEnv()
  const a = doAdapter(opts, { getEnv: async () => f.env, retryMs: 1 })
  return { f, a }
}

describe('doAdapter', () => {
  test('shard index for keys ending 0..f', () => {
    for (let i = 0; i < 16; i++) expect(shardIndex(`conf:x:${i.toString(16)}`)).toBe(i)
    expect(shardIndex('zzz')).toBeLessThan(16)
  })
  test('unknown option is a TypeError; construction and init never touch env', async () => {
    expect(() => doAdapter({ nope: 1 } as never)).toThrow(/nope/)
    const env = new Proxy({}, { get() { throw new Error('env touched') } })
    const a = doAdapter({}, { getEnv: async () => env as never })
    await a.init!(init)
    expect(a.name).toBe('cloudflare-do')
    expect(a.store).toBeUndefined()
    expect(typeof a.broadcast.since).toBe('function')
  })
  test('publish and since track lastSeq via the epoch instance; a failed publish retries once', async () => {
    const { f, a } = mk()
    await a.init!(init)
    f.epoch().fail = 1
    const s = await a.broadcast.publish({ tags: ['a'] }, 'o')
    expect(s).toBe(1)
    expect(f.epoch().publishes).toBe(1)
    expect((await a.broadcast.since(0)).events.map((e) => e.seq)).toEqual([1])
    f.epoch().fail = 2
    await expect(a.broadcast.publish({ tags: ['b'] }, 'o')).rejects.toThrow('boom')
  })
  test('store mode: ONE epoch publish for store.invalidate + publish with the same args, either order', async () => {
    for (const order of ['store-first', 'publish-first'] as const) {
      const { f, a } = mk({ store: true })
      await a.init!(init)
      const args = { tags: ['x'] }
      const calls = order === 'store-first' ? [a.store!.invalidate(args), a.broadcast.publish(args, 'real-origin')] : [a.broadcast.publish(args, 'real-origin'), a.store!.invalidate(args)]
      await Promise.all(calls)
      expect(f.epoch().publishes).toBe(1)
      expect(f.epoch().ring.since(0).events[0]!.origin).toBe('real-origin')
      const fan = Array.from({ length: 16 }, (_, i) => f.shard(i).invalidates.length)
      expect(fan.every((n) => n === 1)).toBe(true)
    }
  })
  test('only one of them called → one publish; without store no shard calls', async () => {
    const a1 = mk({ store: true })
    await a1.a.init!(init)
    await a1.a.store!.invalidate({ tags: ['x'] })
    expect(a1.f.epoch().publishes).toBe(1)
    const a2 = mk()
    await a2.a.init!(init)
    await a2.a.broadcast.publish({ tags: ['x'] }, 'o')
    expect(a2.f.epoch().publishes).toBe(1)
    expect([...a2.f.stubs.keys()]).toEqual(['epoch:ns'])
  })
  test('store mode get stamps with the epoch head and round-trips through the shard', async () => {
    const { f, a } = mk({ store: true })
    await a.init!(init)
    await a.broadcast.publish({ tags: ['q'] }, 'o')
    const key = 'k:3'
    const g = await a.store!.get(key)
    expect(g.stamp).toBe(1)
    const page = { status: 200, headers: [['x', 'y']] as [string, string][], body: new Uint8Array([1, 2, 3]) }
    expect(await a.store!.set(key, page, { ttlMs: 1000, tags: [], method: 'GET', path: '/', stamp: g.stamp })).toBe(true)
    expect(f.shard(3).rows.has(key)).toBe(true)
    const h = await a.store!.get(key)
    expect(Array.from(h.page!.body)).toEqual([1, 2, 3])
    expect(h.entryStamp).toBe(1)
    expect(await a.store!.set(key, { ...page, body: new Uint8Array(1_900_001) }, { ttlMs: 1000, tags: [], method: 'GET', path: '/', stamp: 1 })).toBe(false)
  })
  test('the factory reads the [cache.cloudflare] table keys', async () => {
    const m = (await import('../src/do-adapter')).doFactory
    expect(m({ do_store: true, do_binding: 'X' }).store).toBeDefined()
    expect(() => m({ bogus: 1 })).toThrow(/bogus/)
  })
})
