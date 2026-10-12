import { describe, expect, test } from 'bun:test'
import { kvAdapter } from '../src/kv-adapter'

class FakeKV {
  data = new Map<string, Uint8Array>()
  puts: { key: string; ttl: number | undefined }[] = []
  gets = 0
  dels = 0
  fail429 = false
  async get(key: string, _o: unknown) {
    this.gets++
    const v = this.data.get(key)
    return v ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : null
  }
  async put(key: string, value: Uint8Array, o?: { expirationTtl?: number }) {
    if (this.fail429) {
      this.fail429 = false
      throw new Error('KV PUT failed: 429 Too Many Requests')
    }
    this.puts.push({ key, ttl: o?.expirationTtl })
    this.data.set(key, new Uint8Array(value))
  }
  async delete(key: string) {
    this.dels++
    this.data.delete(key)
  }
}
const page = (s: string) => ({ status: 200, headers: [['content-type', 'text/html'], ['x-a', '1'], ['x-a', '2']] as [string, string][], body: new TextEncoder().encode(s) })
const meta = (o = {}) => ({ ttlMs: 600_000, tags: ['t'], method: 'GET', path: '/p', stamp: null, ...o })
const make = (opts = {}, kv = new FakeKV(), now = () => 1_000_000) => ({ kv, a: kvAdapter(opts, { getEnv: async () => ({ BRUST_CACHE: kv, OTHER: kv }), now }) })

describe('kvAdapter', () => {
  test('options: unknown key is a TypeError naming it; binding and min_ttl_s are read', () => {
    expect(() => kvAdapter({ nope: 1 } as never)).toThrow(/nope/)
    const { a, kv } = make({ binding: 'OTHER', min_ttl_s: 0 })
    return a.store.set('k', page('x'), meta({ ttlMs: 30_000 })).then((ok) => {
      expect(ok).toBe(true)
      expect(kv.puts[0]!.ttl).toBe(60)
    })
  })
  test('constructing never touches env', () => {
    const env = new Proxy({}, { get() { throw new Error('env touched') } })
    const a = kvAdapter({}, { getEnv: async () => env as never })
    expect(a.name).toBe('cloudflare-kv')
    expect(a.runtimes).toEqual(['workers'])
  })
  test('min ttl: 299 s refused, 300 s put with expirationTtl 300', async () => {
    const { a, kv } = make()
    expect(await a.store.set('a', page('x'), meta({ ttlMs: 299_000 }))).toBe(false)
    expect(kv.puts).toHaveLength(0)
    expect(await a.store.set('a', page('x'), meta({ ttlMs: 300_000 }))).toBe(true)
    expect(kv.puts[0]!.ttl).toBe(300)
  })
  test('round trip keeps status, headers (repeats), body, entryStamp, storedAt; stamp is null; expiry on read', async () => {
    let t = 1_000_000
    const { a } = make({}, new FakeKV(), () => t)
    await a.store.set('k', page('hello'), meta({ stamp: 7 }))
    const g = await a.store.get('k')
    expect(g.page!.status).toBe(200)
    expect(g.page!.headers).toEqual([['content-type', 'text/html'], ['x-a', '1'], ['x-a', '2']])
    expect(new TextDecoder().decode(g.page!.body)).toBe('hello')
    expect([g.stamp, g.entryStamp, g.storedAt]).toEqual([null, 7, 1_000_000])
    t += 600_001
    expect((await a.store.get('k')).page).toBeNull()
  })
  test('an identical frame within 60 s is not rewritten; a changed body is; a 429 is false', async () => {
    let t = 1_000_000
    const { a, kv } = make({}, new FakeKV(), () => t)
    expect(await a.store.set('k', page('same'), meta())).toBe(true)
    t += 1000
    expect(kv.puts).toHaveLength(1)
    expect(await a.store.set('k', page('same'), meta())).toBe(true) // same content, clock moved: still not rewritten
    expect(kv.puts).toHaveLength(1)
    const n = kv.puts.length
    expect(await a.store.set('k', page('different'), meta())).toBe(true)
    expect(kv.puts.length).toBe(n + 1)
    kv.fail429 = true
    expect(await a.store.set('other', page('x'), meta())).toBe(false)
  })
  test('a missing binding rejects with the wrangler hint', async () => {
    const a = kvAdapter({}, { getEnv: async () => ({}) })
    await expect(a.store.get('k')).rejects.toThrow('KV binding "BRUST_CACHE" is not bound (add it to wrangler.jsonc)')
  })
  test('invalidate resolves with no KV call', async () => {
    const { a, kv } = make()
    await a.store.invalidate({ tags: ['t'] })
    expect([kv.gets, kv.puts.length, kv.dels]).toEqual([0, 0, 0])
  })
})
