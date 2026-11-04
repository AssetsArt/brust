// `@brust/core/cache-adapter/conformance`: the cases every cache adapter must pass (spec §9),
// registered with bun:test. Built-ins (lanes B/C) and custom adapters run the same suite:
//
//   import { runConformance } from '@brust/core/cache-adapter/conformance'
//   runConformance(() => myAdapter(opts), { push: true, guard: true })
//
// Each case builds a fresh adapter with `make()` and closes it afterwards. Keys are unique per case.
import { afterEach, describe, expect, test } from 'bun:test'
import type { CacheAdapter, InvalidationEvent, SetMeta, StoredPage } from './types'

export interface ConformanceCaps {
  /** The broadcast is push (`subscribe`). */
  push?: boolean
  /** The broadcast is pull (`since`). */
  pull?: boolean
  /** The store refuses stale writes exactly (Redis Lua, DO, memory). */
  guard?: boolean
  /** The store invalidates (default true); `false` skips the tag/path invalidation cases (Cloudflare KV alone never invalidates). */
  invalidate?: boolean
}

const enc = new TextEncoder()
const page = (body: string | Uint8Array, headers: [string, string][] = [['content-type', 'text/html']]): StoredPage => ({
  status: 200,
  headers,
  body: typeof body === 'string' ? enc.encode(body) : body,
})
const meta = (o: Partial<SetMeta> = {}): SetMeta => ({ ttlMs: 60_000, tags: [], method: 'GET', path: '/', stamp: null, ...o })

async function until(what: string, f: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

export function runConformance(make: () => CacheAdapter | Promise<CacheAdapter>, caps: ConformanceCaps = {}): void {
  let open: CacheAdapter[] = []
  let n = 0
  const key = () => `conf:${Date.now().toString(36)}:${n++}`
  const fresh = async () => {
    const a = await make()
    await a.init?.({ namespace: 'conformance', buildId: 'b0', runtime: 'bun', workerId: 0 })
    open.push(a)
    return a
  }
  const store = async () => {
    const a = await fresh()
    if (!a.store) throw new Error(`adapter ${a.name} has no store`)
    return { a, s: a.store }
  }
  afterEach(async () => {
    const all = open
    open = []
    await Promise.allSettled(all.map(a => a.close?.()))
  })

  describe('cache adapter conformance', () => {
    test('get of an absent key is a miss', async () => {
      const { s } = await store()
      const r = await s.get(key())
      expect(r.page).toBeNull()
      expect(r.entryStamp).toBeNull()
    })

    test('set then get round-trips status, headers (order + repeats) and body', async () => {
      const { s } = await store()
      const k = key()
      const headers: [string, string][] = [
        ['content-type', 'text/html; charset=utf-8'],
        ['x-a', '1'],
        ['x-a', '2'],
        ['cache-control', 'no-store'],
      ]
      expect(await s.set(k, { status: 203, headers, body: enc.encode('<p>hi</p>') }, meta())).toBe(true)
      const r = await s.get(k)
      expect(r.page?.status).toBe(203)
      expect(r.page?.headers).toEqual(headers)
      expect(new TextDecoder().decode(r.page!.body)).toBe('<p>hi</p>')
      expect(typeof r.storedAt === 'number' || r.storedAt === null).toBe(true)
    })

    test('bodies are binary-safe (all 256 byte values)', async () => {
      const { s } = await store()
      const k = key()
      const body = Uint8Array.from({ length: 512 }, (_, i) => i % 256)
      expect(await s.set(k, page(body), meta())).toBe(true)
      expect(Array.from((await s.get(k)).page!.body)).toEqual(Array.from(body))
    })

    test('entryStamp round-trips the set stamp', async () => {
      const { a, s } = await store()
      const k = key()
      const g = await s.get(k)
      if (a.broadcast) expect(typeof g.stamp).toBe('number')
      expect(await s.set(k, page('x'), meta({ stamp: g.stamp }))).toBe(true)
      expect((await s.get(k)).entryStamp).toBe(g.stamp)
    })

    test('entries expire after ttlMs', async () => {
      const { s } = await store()
      const k = key()
      expect(await s.set(k, page('x'), meta({ ttlMs: 1 }))).toBe(true)
      await until('expiry', async () => (await s.get(k)).page === null)
    })

    if (caps.invalidate !== false) test('tag invalidation drops tagged pages and keeps unrelated ones', async () => {
      const { s } = await store()
      const [k1, k2, k3] = [key(), key(), key()]
      await s.set(k1, page('1'), meta({ tags: ['items'], path: '/a' }))
      await s.set(k2, page('2'), meta({ tags: ['other', 'items'], path: '/b' }))
      await s.set(k3, page('3'), meta({ tags: ['other'], path: '/c' }))
      await s.invalidate({ tags: ['items'] })
      expect((await s.get(k1)).page).toBeNull()
      expect((await s.get(k2)).page).toBeNull()
      expect((await s.get(k3)).page).not.toBeNull()
    })

    if (caps.invalidate !== false) test('path + method invalidation drops that page only', async () => {
      const { s } = await store()
      const [k1, k2] = [key(), key()]
      await s.set(k1, page('1'), meta({ path: '/x' }))
      await s.set(k2, page('2'), meta({ path: '/y' }))
      await s.invalidate({ path: '/x', method: 'POST' })
      expect((await s.get(k1)).page).not.toBeNull()
      await s.invalidate({ path: '/x' })
      expect((await s.get(k1)).page).toBeNull()
      expect((await s.get(k2)).page).not.toBeNull()
    })

    if (caps.invalidate !== false) test('F493: prefix + path drops that prefix\'s page only', async () => {
      const { s } = await store()
      const [a, b, none] = [key(), key(), key()]
      await s.set(a, page('a'), meta({ path: '/x', prefix: 'a.test' }))
      await s.set(b, page('b'), meta({ path: '/x', prefix: 'b.test' }))
      await s.set(none, page('n'), meta({ path: '/x', prefix: '' }))
      await s.invalidate({ prefix: 'a.test', path: '/x' })
      expect((await s.get(a)).page).toBeNull()
      expect((await s.get(b)).page).not.toBeNull()
      expect((await s.get(none)).page).not.toBeNull()
      // `''` is exact: it matches the entry with no prefix only.
      await s.invalidate({ prefix: '', path: '/x' })
      expect((await s.get(none)).page).toBeNull()
      expect((await s.get(b)).page).not.toBeNull()
    })

    if (caps.invalidate !== false) test('F493: prefix + tags drops that prefix\'s tagged pages; the other prefix stays tagged', async () => {
      const { s } = await store()
      const [a, b, a2] = [key(), key(), key()]
      await s.set(a, page('a'), meta({ tags: ['page'], path: '/p', prefix: 'a.test' }))
      await s.set(b, page('b'), meta({ tags: ['page'], path: '/p', prefix: 'b.test' }))
      await s.set(a2, page('a2'), meta({ tags: ['other'], path: '/q', prefix: 'a.test' }))
      await s.invalidate({ prefix: 'a.test', tags: ['page'] })
      expect((await s.get(a)).page).toBeNull()
      expect((await s.get(b)).page).not.toBeNull()
      expect((await s.get(a2)).page).not.toBeNull()
      await s.invalidate({ tags: ['page'] })
      expect((await s.get(b)).page).toBeNull()
    })

    if (caps.invalidate !== false) test('F493: prefix alone drops every page of that prefix', async () => {
      const { s } = await store()
      const [a1, a2, b] = [key(), key(), key()]
      await s.set(a1, page('1'), meta({ path: '/x', prefix: 'a.test' }))
      await s.set(a2, page('2'), meta({ tags: ['t'], path: '/y', prefix: 'a.test' }))
      await s.set(b, page('b'), meta({ path: '/x', prefix: 'b.test' }))
      await s.invalidate({ prefix: 'a.test' })
      expect((await s.get(a1)).page).toBeNull()
      expect((await s.get(a2)).page).toBeNull()
      expect((await s.get(b)).page).not.toBeNull()
    })

    test('key invalidation is a store no-op', async () => {
      const { s } = await store()
      const k = key()
      await s.set(k, page('1'), meta({ tags: ['t'] }))
      await s.invalidate({ key: 'job-key' })
      expect((await s.get(k)).page).not.toBeNull()
    })

    test('a body over maxBodyBytes is refused', async () => {
      const { s } = await store()
      const k = key()
      expect(await s.set(k, page(new Uint8Array(s.maxBodyBytes + 1)), meta())).toBe(false)
      expect((await s.get(k)).page).toBeNull()
    })

    if (caps.guard) {
      test('a set whose stamp predates an invalidation of its tag is refused', async () => {
        const { a, s } = await store()
        const k = key()
        const g = await s.get(k)
        await s.invalidate({ tags: ['items'] })
        await a.broadcast?.publish({ tags: ['items'] }, 'conf')
        expect(await s.set(k, page('stale'), meta({ tags: ['items'], stamp: g.stamp }))).toBe(false)
        expect((await s.get(k)).page).toBeNull()
        const g2 = await s.get(k)
        expect(await s.set(k, page('fresh'), meta({ tags: ['items'], stamp: g2.stamp }))).toBe(true)
      })

      test('L7b: a stale set racing invalidate (before its publish) never lands', async () => {
        const { s } = await store()
        const k = key()
        const g = await s.get(k)
        await s.invalidate({ tags: ['items'], path: '/p' })
        expect(await s.set(k, page('stale'), meta({ tags: ['items'], stamp: g.stamp }))).toBe(false)
        expect(await s.set(k, page('stale'), meta({ path: '/p', stamp: g.stamp }))).toBe(false)
        expect((await s.get(k)).page).toBeNull()
      })
    }

    if (caps.guard) {
      test('F493: a set whose stamp predates an invalidation of its prefix is refused; another prefix lands', async () => {
        const { a, s } = await store()
        const [k, other] = [key(), key()]
        const g = await s.get(k)
        await s.invalidate({ prefix: 'a.test' })
        await a.broadcast?.publish({ prefix: 'a.test' }, 'conf')
        expect(await s.set(k, page('stale'), meta({ path: '/p', prefix: 'a.test', stamp: g.stamp }))).toBe(false)
        expect((await s.get(k)).page).toBeNull()
        expect(await s.set(other, page('b'), meta({ path: '/p', prefix: 'b.test', stamp: g.stamp }))).toBe(true)
        const g2 = await s.get(k)
        expect(await s.set(k, page('fresh'), meta({ path: '/p', prefix: 'a.test', stamp: g2.stamp }))).toBe(true)
      })
    }

    test('F493: the broadcast carries prefix in its args', async () => {
      const a = await fresh()
      if (!a.broadcast?.subscribe && !a.broadcast?.since) return
      const args = { prefix: 'a.test', path: '/b' }
      if (a.broadcast.subscribe) {
        const got: InvalidationEvent[] = []
        const stop = await a.broadcast.subscribe(e => got.push(e), () => {})
        const seq = await a.broadcast.publish(args, 'o1')
        await until('delivery', () => got.length === 1)
        expect(got[0]).toEqual({ seq, origin: 'o1', args })
        await stop()
      } else {
        const base = (await a.broadcast.since!(0)).seq
        await a.broadcast.publish(args, 'o1')
        expect((await a.broadcast.since!(base)).events.map(e => e.args)).toEqual([args])
      }
    })

    test('publish seqs strictly increase; get().stamp is the last seq (one space)', async () => {
      const a = await fresh()
      if (!a.broadcast) return
      const s1 = await a.broadcast.publish({ tags: ['a'] }, 'conf')
      const s2 = await a.broadcast.publish({ path: '/b' }, 'conf')
      expect(s2).toBeGreaterThan(s1)
      if (a.store) expect((await a.store.get(key())).stamp).toBe(s2)
    })

    if (caps.push) {
      test('push: in-order delivery with origin and args; unsubscribe stops it', async () => {
        const a = await fresh()
        const got: InvalidationEvent[] = []
        const stop = await a.broadcast!.subscribe!(e => got.push(e), () => {})
        const s1 = await a.broadcast!.publish({ tags: ['a'] }, 'o1')
        const s2 = await a.broadcast!.publish({ path: '/b', method: 'GET' }, 'o2')
        await until('delivery', () => got.length === 2)
        expect(got).toEqual([
          { seq: s1, origin: 'o1', args: { tags: ['a'] } },
          { seq: s2, origin: 'o2', args: { path: '/b', method: 'GET' } },
        ])
        await stop()
        await a.broadcast!.publish({ tags: ['c'] }, 'o1')
        await new Promise(r => setTimeout(r, 50))
        expect(got.length).toBe(2)
      })
    }

    if (caps.pull) {
      test('pull: since(0) after three publishes is contiguous', async () => {
        const a = await fresh()
        const b = a.broadcast!
        const before = await b.since!(0)
        const base = before.seq
        for (const t of ['a', 'b', 'c']) await b.publish({ tags: [t] }, 'o')
        const r = await b.since!(base)
        expect(r.behind).toBe(false)
        expect(r.seq).toBe(base + 3)
        expect(r.events.map(e => e.seq)).toEqual([base + 1, base + 2, base + 3])
        expect(r.events.map(e => e.args.tags?.[0])).toEqual(['a', 'b', 'c'])
        expect(r.events[0]!.origin).toBe('o')
        expect((await b.since!(r.seq)).events).toEqual([])
        expect(typeof r.gen).toBe('string')
      })

      test('pull: a reader past the retained history is behind', async () => {
        const a = await fresh()
        const b = a.broadcast!
        const base = (await b.since!(0)).seq
        // 1025 events is beyond the spec's 1024-event ring.
        for (let i = 0; i < 1025; i++) await b.publish({ tags: [`t${i}`] }, 'o')
        expect((await b.since!(base)).behind).toBe(true)
      })
    }
  })
}
