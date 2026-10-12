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
  test("store mode, lane A's order (store.invalidate then publish): ONE epoch publish with the real origin; markers at head + 1", async () => {
    const { f, a } = mk({ store: true })
    await a.init!(init)
    const args = { tags: ['x'] }
    await a.store!.invalidate(args)
    expect(f.epoch().publishes).toBe(0)
    expect(Array.from({ length: 16 }, (_, i) => f.shard(i).invalidates.map((x) => x.seq))).toEqual(Array.from({ length: 16 }, () => [1]))
    expect(await a.broadcast.publish(args, 'real-origin')).toBe(1)
    expect(f.epoch().publishes).toBe(1)
    expect(f.epoch().ring.since(0).events[0]!.origin).toBe('real-origin')
    // the real seq equalled the predicted one: no second round of shard markers
    expect(Array.from({ length: 16 }, (_, i) => f.shard(i).invalidates.length).every((n) => n === 1)).toBe(true)
  })
  test('a publish that took a different seq than predicted re-marks the shards', async () => {
    const { f, a } = mk({ store: true })
    await a.init!(init)
    const args = { tags: ['x'] }
    await a.store!.invalidate(args)
    await f.epoch().publish({ tags: ['other'] }, 'someone') // another isolate published in between
    expect(await a.broadcast.publish(args, 'me')).toBe(2)
    expect(f.shard(0).invalidates.map((x) => x.seq)).toEqual([1, 2])
  })
  test('publish alone → one publish and 16 shard markers; without store no shard calls', async () => {
    const a1 = mk({ store: true })
    await a1.a.init!(init)
    await a1.a.broadcast.publish({ tags: ['x'] }, 'o')
    expect(a1.f.epoch().publishes).toBe(1)
    expect(Array.from({ length: 16 }, (_, i) => a1.f.shard(i).invalidates.length).every((n) => n === 1)).toBe(true)
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
