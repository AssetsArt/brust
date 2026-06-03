import { afterEach, describe, expect, test } from 'bun:test'
import { cachedFetch, dedupe, runInRequestCache } from './loader-cache.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('dedupe', () => {
  test('same key, two concurrent calls → fn invoked ONCE, both resolve to same value', async () => {
    await runInRequestCache(async () => {
      let calls = 0
      const fn = () => {
        calls++
        return Promise.resolve('value')
      }
      const [a, b] = await Promise.all([dedupe('k', fn), dedupe('k', fn)])
      expect(calls).toBe(1)
      expect(a).toBe('value')
      expect(b).toBe('value')
    })
  })

  test('different keys → fn invoked per key', async () => {
    await runInRequestCache(async () => {
      let calls = 0
      const fn = () => {
        calls++
        return Promise.resolve('v')
      }
      await Promise.all([dedupe('a', fn), dedupe('b', fn)])
      expect(calls).toBe(2)
    })
  })

  test('fn rejects → key deleted; a later dedupe(sameKey, fn2) invokes fn2 (error not cached)', async () => {
    await runInRequestCache(async () => {
      let fn2Called = false
      const fn1 = () => Promise.reject(new Error('boom'))
      const fn2 = () => {
        fn2Called = true
        return Promise.resolve('ok')
      }
      await expect(dedupe('k', fn1)).rejects.toThrow('boom')
      // ensure the guarded catch has run
      await Promise.resolve()
      const result = await dedupe('k', fn2)
      expect(fn2Called).toBe(true)
      expect(result).toBe('ok')
    })
  })

  test('two concurrent callers of a rejecting key both see the rejection (no hang)', async () => {
    await runInRequestCache(async () => {
      let calls = 0
      const fn = () => {
        calls++
        return Promise.reject(new Error('boom'))
      }
      const a = dedupe('k', fn)
      const b = dedupe('k', fn) // shares the in-flight rejecting promise
      await expect(a).rejects.toThrow('boom')
      await expect(b).rejects.toThrow('boom')
      expect(calls).toBe(1) // shared, fn invoked once
    })
  })

  test('called OUTSIDE any runInRequestCache scope → passthrough (fn invoked every call, no throw)', async () => {
    let calls = 0
    const fn = () => {
      calls++
      return Promise.resolve('v')
    }
    await dedupe('k', fn)
    await dedupe('k', fn)
    expect(calls).toBe(2)
  })

  test('two SEPARATE scopes calling dedupe(sameKey) → fn invoked once PER scope (isolation)', async () => {
    let calls = 0
    const fn = () => {
      calls++
      return Promise.resolve('v')
    }
    await runInRequestCache(async () => {
      await Promise.all([dedupe('k', fn), dedupe('k', fn)])
    })
    await runInRequestCache(async () => {
      await Promise.all([dedupe('k', fn), dedupe('k', fn)])
    })
    expect(calls).toBe(2)
  })
})

describe('cachedFetch', () => {
  test('outside any scope → passthrough (fetch invoked every call, no throw)', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(new Response('body'))
    }) as typeof fetch
    await cachedFetch('http://x/a')
    await cachedFetch('http://x/a')
    expect(calls).toBe(2)
  })

  test('GET same url twice concurrently in one scope → fetch ONCE; both callers read body (per-caller clone)', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(
        new Response(JSON.stringify({ n: 1 }), { headers: { 'content-type': 'application/json' } }),
      )
    }) as typeof fetch
    await runInRequestCache(async () => {
      const [r1, r2] = await Promise.all([cachedFetch('http://x/a'), cachedFetch('http://x/a')])
      expect(calls).toBe(1)
      const [b1, b2] = await Promise.all([r1.json(), r2.json()])
      expect(b1).toEqual({ n: 1 })
      expect(b2).toEqual({ n: 1 })
    })
  })

  test('POST → bypass: fetch called every time (not cached)', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(new Response('ok'))
    }) as typeof fetch
    await runInRequestCache(async () => {
      await cachedFetch('http://x/a', { method: 'POST' })
      await cachedFetch('http://x/a', { method: 'POST' })
      expect(calls).toBe(2)
    })
  })
})
