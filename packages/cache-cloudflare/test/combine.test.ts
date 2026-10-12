import { describe, expect, test } from 'bun:test'
import { doAdapter } from '../src/do-adapter'
import { kvAdapter } from '../src/kv-adapter'
import { fakeDoEnv } from './fakes'

class FakeKV {
  data = new Map<string, Uint8Array>()
  async get(key: string) { const v = this.data.get(key); return v ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : null }
  async put(key: string, value: Uint8Array) { this.data.set(key, new Uint8Array(value)) }
  async delete(key: string) { this.data.delete(key) }
}
const init = { namespace: 'ns', buildId: 'b', runtime: 'workers' as const, workerId: 0 }
const page = (s = 'x') => ({ status: 200, headers: [] as [string, string][], body: new TextEncoder().encode(s) })
const meta = (o = {}) => ({ ttlMs: 600_000, tags: ['x'], method: 'GET', path: '/p', stamp: null as number | null, ...o })

/** Two "isolates" (separate adapters) over ONE KV and ONE epoch, as in production. */
function world() {
  const f = fakeDoEnv()
  const kv = new FakeKV()
  const env = { ...f.env, BRUST_CACHE: kv }
  const isolate = () => {
    const d = doAdapter({}, { getEnv: async () => env, retryMs: 1 })
    const k = kvAdapter({ min_ttl_s: 0 }, { getEnv: async () => env })
    return d.composeWith(k)
  }
  return { f, kv, isolate }
}

describe('combine', () => {
  test('identity: name, runtimes, init forwards; composeWith(kv) is what the composer returns', async () => {
    const { isolate } = world()
    const c = isolate()
    expect(c.name).toBe('cloudflare-kv+do')
    expect(c.runtimes).toEqual(['workers'])
    await c.init!(init)
    expect(typeof c.broadcast!.since).toBe('function')
  })
  test('refuses a non-KV store', () => {
    const d = doAdapter({}, { getEnv: async () => ({}) })
    expect(() => d.composeWith({ name: 'memory', runtimes: ['workers'], store: { get: async () => ({ page: null, stamp: null, entryStamp: null, storedAt: null }), set: async () => true, invalidate: async () => {}, maxBodyBytes: 1 } })).toThrow(/cloudflare-kv/)
  })
  test('seeds from the DO once (first get); stamp is the known seq; a guarded set below a floor is refused', async () => {
    const { f, isolate } = world()
    const c = isolate(); await c.init!(init)
    const g = await c.store!.get('k')
    expect(f.epoch().floorsCalls).toBe(1)
    expect(g.stamp).toBe(0)
    await c.store!.get('k2')
    expect(f.epoch().floorsCalls).toBe(1)
    await c.broadcast!.publish({ tags: ['x'] }, 'o')
    expect(await c.store!.set('k', page(), meta({ stamp: 0 }))).toBe(false)
    expect(await c.store!.set('k', page(), meta({ stamp: 1 }))).toBe(true)
  })
  test('a replayed event hides matching KV entries by entryStamp, not unrelated ones', async () => {
    const { f, isolate } = world()
    const c = isolate(); await c.init!(init)
    const g = await c.store!.get('k')
    await c.store!.set('kx', page(), meta({ stamp: g.stamp, tags: ['x'] }))
    await c.store!.set('ky', page(), meta({ stamp: g.stamp, tags: ['y'] }))
    // another isolate publishes: this one only learns it through `since`
    await f.epoch().publish({ tags: ['x'] }, 'remote')
    await c.broadcast!.since!(0)
    expect((await c.store!.get('kx')).page).toBeNull()
    expect((await c.store!.get('ky')).page).not.toBeNull()
  })
  test('an unknown name with evicted 7 and entryStamp 5 is a miss', async () => {
    const { f, isolate } = world()
    f.epoch().evicted = 7
    const c = isolate(); await c.init!(init)
    await c.store!.get('k')
    await c.store!.set('k', page(), meta({ stamp: 5, tags: ['zzz'] }))
    // the set itself is refused (stamp 5 < evicted 7), so nothing is stored
    expect((await c.store!.get('k')).page).toBeNull()
  })
  test('the new-isolate gap: a fresh isolate seeds the floor and refuses a KV body invalidated before it started', async () => {
    const { f, isolate } = world()
    const a = isolate(); await a.init!(init)
    const g = await a.store!.get('k')
    await a.store!.set('k', page('old'), meta({ stamp: g.stamp }))
    await a.broadcast!.publish({ tags: ['x'] }, 'a')          // invalidated while only isolate a existed
    const b = isolate(); await b.init!(init)                    // a NEW isolate: no events to replay
    expect((await b.store!.get('k')).page).toBeNull()
    expect(f.epoch().floorsCalls).toBe(2)
  })
  test('store.invalidate alone hides the page at once and refuses a set at the old stamp', async () => {
    const { isolate } = world()
    const c = isolate(); await c.init!(init)
    const g = await c.store!.get('k')
    await c.store!.set('k', page(), meta({ stamp: g.stamp }))
    await c.store!.invalidate({ tags: ['x'] })
    expect((await c.store!.get('k')).page).toBeNull()
    expect(await c.store!.set('k', page(), meta({ stamp: g.stamp }))).toBe(false)
  })
  test('a gen change re-seeds the floors', async () => {
    const { f, isolate } = world()
    const c = isolate(); await c.init!(init)
    await c.store!.get('k')
    await c.broadcast!.since!(0)
    expect(f.epoch().floorsCalls).toBe(1)
    f.epoch().regen()
    await c.broadcast!.since!(0)
    expect(f.epoch().floorsCalls).toBe(2)
  })
  test('an unguarded set (stamp null) is stamped with the known seq', async () => {
    const { isolate } = world()
    const c = isolate(); await c.init!(init)
    expect(await c.store!.set('k', page(), meta())).toBe(true)
    expect((await c.store!.get('k')).entryStamp).toBe(0)
  })
})
