import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import type { InvalidationEvent } from '@brust/core/cache-adapter'
import { html, make, makeOffline, meta, ns, servers, sweep } from './servers'

afterAll(sweep)

async function until(what: string, f: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await Bun.sleep(10)
  }
}

for (const [flavor, url] of servers()) {
  describe(`broadcast (${flavor})`, () => {
    test('a paired invalidate + publish is ONE script: seq +1, markers = seq, pages gone', async () => {
      const a = await make(flavor, url)
      const c = a.__test.client()
      const K = a.__test.keys()
      await a.store!.set('p1', html('x'), meta({ tags: ['t'], path: '/p1' }))
      const args = { tags: ['t'], path: '/p1' }
      const seq0 = Number((await c.get(K.seq)) ?? 0)
      const [, pub] = await Promise.allSettled([a.store!.invalidate(args), a.broadcast!.publish(args, 'o')])
      expect(pub).toEqual({ status: 'fulfilled', value: seq0 + 1 })
      expect(Number(await c.get(K.seq))).toBe(seq0 + 1)
      expect(Number(await c.get(K.markTag('t')))).toBe(seq0 + 1)
      expect(Number(await c.get(K.markPath('GET', '/p1')))).toBe(seq0 + 1)
      expect((await a.store!.get('p1')).page).toBeNull()
      // The guard now refuses a write stamped before the invalidation, accepts one stamped after.
      expect(await a.store!.set('p1', html('y'), meta({ tags: ['t'], path: '/p1', stamp: seq0 }))).toBe(false)
      expect(await a.store!.set('p1', html('y'), meta({ tags: ['t'], path: '/p1', stamp: seq0 + 1 }))).toBe(true)
    })

    test('lane A order (invalidate, then publish in a later tick) is correct without pairing', async () => {
      const a = await make(flavor, url)
      const c = a.__test.client()
      const K = a.__test.keys()
      await a.store!.set('p', html('x'), meta({ tags: ['t'] }))
      const args = { tags: ['t'] }
      await a.store!.invalidate(args)
      expect(Number((await c.get(K.seq)) ?? 0)).toBe(0) // seq never jumps without an event
      expect(Number(await c.get(K.markTag('t')))).toBe(1)
      expect((await a.store!.get('p')).page).toBeNull()
      expect(await a.store!.set('p', html('x'), meta({ tags: ['t'], stamp: 0 }))).toBe(false)
      expect(await a.broadcast!.publish(args, 'o')).toBe(1)
      expect(Number(await c.get(K.markTag('t')))).toBe(1)
      expect(await a.store!.set('p', html('x'), meta({ tags: ['t'], stamp: 1 }))).toBe(true)
    })

    test('a standalone publish: +1, no deletes; a standalone invalidate: seq unchanged, writes blocked until a publish', async () => {
      const a = await make(flavor, url)
      const c = a.__test.client()
      const K = a.__test.keys()
      await a.store!.set('p', html('x'), meta({ tags: ['t'] }))
      expect(await a.broadcast!.publish({ tags: ['t'] }, 'o')).toBe(1)
      expect((await a.store!.get('p')).page).not.toBeNull()
      expect(Number(await c.get(K.seq))).toBe(1)
      await a.store!.invalidate({ tags: ['u'] })
      expect(Number(await c.get(K.seq))).toBe(1)
      expect(await a.store!.set('q', html('x'), meta({ tags: ['u'], stamp: 1 }))).toBe(false)
      expect(await a.broadcast!.publish({ tags: ['u'] }, 'o')).toBe(2)
      expect(await a.store!.set('q', html('x'), meta({ tags: ['u'], stamp: 2 }))).toBe(true)
    })

    test('a key-only invalidation touches nothing but seq on publish', async () => {
      const a = await make(flavor, url)
      await a.store!.invalidate({ key: 'k' })
      expect(Number((await a.__test.client().get(a.__test.keys().seq)) ?? 0)).toBe(0)
      expect(await a.broadcast!.publish({ key: 'k' }, 'o')).toBe(1)
    })

    test('1 200 tagged pages invalidated in UNLINK batches', async () => {
      const a = await make(flavor, url, { unlink_batch: 500 })
      const c = a.__test.client()
      const K = a.__test.keys()
      await Promise.all(Array.from({ length: 1200 }, (_, i) => a.store!.set(`m${i}`, html(`b${i}`), meta({ tags: ['big'], path: `/m${i}` }))))
      expect(Number(await c.send('SCARD', [K.tag('big')]))).toBe(1200)
      await Promise.all([a.store!.invalidate({ tags: ['big'] }), a.broadcast!.publish({ tags: ['big'] }, 'o')])
      for (const i of [0, 599, 1199]) expect((await a.store!.get(`m${i}`)).page).toBeNull()
      expect(Number(await c.send('EXISTS', [K.tag('big')]))).toBe(0)
      const left = (await c.send('SCAN', ['0', 'MATCH', K.page('*'), 'COUNT', '5000'])) as [string, string[]]
      expect(left[1]).toEqual([])
    })

    test('push delivery carries origin and args across two adapters; unsubscribe stops it', async () => {
      const space = ns()
      const a = await make(flavor, url, {}, space)
      const b = await make(flavor, url, {}, space)
      const got: InvalidationEvent[] = []
      const off = await b.broadcast!.subscribe!((e) => got.push(e), () => {})
      await a.broadcast!.publish({ tags: ['x'], path: '/y' }, 'origin-a')
      await until('event', () => got.length === 1)
      expect(got[0]).toEqual({ seq: 1, origin: 'origin-a', args: { tags: ['x'], path: '/y' } })
      await off()
      await a.broadcast!.publish({ tags: ['x'] }, 'origin-a')
      await Bun.sleep(150)
      expect(got.length).toBe(1)
    })

    test('a dropped subscriber reconnects and reports the gap exactly once', async () => {
      const space = ns()
      const b = await make(flavor, url, { reconnect_min_ms: 300 }, space)
      const a = await make(flavor, url, {}, space)
      let gaps = 0
      const got: number[] = []
      await b.broadcast!.subscribe!((e) => got.push(e.seq), () => gaps++)
      expect(b.__test.state().subscribed).toBe(true)
      b.__test.dropSubscriber()
      await Bun.sleep(30)
      await a.broadcast!.publish({ tags: ['x'] }, 'o') // inside the outage: lost to b
      await until('gap', () => gaps >= 1, 3000)
      await until('resubscribed', () => b.__test.state().subscribed)
      await Bun.sleep(300)
      expect(gaps).toBe(1)
      expect(got).toEqual([])
      await a.broadcast!.publish({ tags: ['x'] }, 'o')
      await until('delivery after reconnect', () => got.length === 1)
    })

    test('a reconnect with nothing missed reports no gap', async () => {
      const space = ns()
      const b = await make(flavor, url, { reconnect_min_ms: 50 }, space)
      let gaps = 0
      await b.broadcast!.subscribe!(() => {}, () => gaps++)
      b.__test.dropSubscriber()
      await until('resubscribed', () => b.__test.state().subscribed && b.__test.state().reconnects > 0)
      await Bun.sleep(200)
      expect(gaps).toBe(0)
    })

    test('CLIENT KILL TYPE pubsub: the subscriber comes back', async () => {
      const space = ns()
      const b = await make(flavor, url, { reconnect_min_ms: 100 }, space)
      const a = await make(flavor, url, {}, space)
      const got: number[] = []
      await b.broadcast!.subscribe!((e) => got.push(e.seq), () => {})
      try {
        await b.__test.client().send('CLIENT', ['KILL', 'TYPE', 'pubsub'])
      } catch (e) {
        console.log(`[${flavor}] CLIENT KILL TYPE pubsub unsupported: ${String(e)}`)
        return
      }
      await until('resubscribed', () => b.__test.state().subscribed && b.__test.state().reconnects > 0)
      await a.broadcast!.publish({ tags: ['x'] }, 'o')
      await until('delivery', () => got.length >= 1)
    })
  })
}

// No server needed: the dead port is the point.
describe('offline', () => {
  test('boot with the server down: init resolves, commands fail fast, no leak, close stops the loop', async () => {
    const warns: string[] = []
    const w = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.join(' ')))
    const unhandled: unknown[] = []
    const onU = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onU)
    try {
      const a = await makeOffline('redis://:s3cr3t@127.0.0.1:1', { connect_timeout_ms: 300, reconnect_min_ms: 50, reconnect_max_ms: 100 })
      const t0 = Date.now()
      // init already resolved inside make(); re-time a fresh one for the budget.
      const b = await makeOffline('redis://:s3cr3t@127.0.0.1:1', { connect_timeout_ms: 300, reconnect_min_ms: 50, reconnect_max_ms: 100 })
      expect(Date.now() - t0).toBeLessThan(300 + 500)
      const g0 = Date.now()
      await expect(a.store!.get('k')).rejects.toThrow()
      expect(Date.now() - g0).toBeLessThan(100)
      await expect(a.store!.set('k', html('x'), meta())).rejects.toThrow()
      const off = await a.broadcast!.subscribe!(() => {}, () => {})
      await Bun.sleep(400)
      expect(a.__test.state().reconnects).toBeGreaterThan(0)
      await off()
      await a.close!()
      await b.close!()
      const r = a.__test.state().reconnects + b.__test.state().reconnects
      await Bun.sleep(500)
      expect(a.__test.state().reconnects + b.__test.state().reconnects).toBe(r)
      expect(warns.length).toBeGreaterThan(0)
      expect(warns.join('\n')).not.toContain('s3cr3t')
      expect(warns.join('\n')).toContain('127.0.0.1:1')
      expect(unhandled).toEqual([])
    } finally {
      w.mockRestore()
      process.off('unhandledRejection', onU)
    }
  })

  test('a throwing option never echoes the url value', async () => {
    const { createAdapter } = await import('../src/adapter')
    expect(() => createAdapter('redis', { url: '' })).toThrow(/url is required/)
    expect(() => createAdapter('redis', { url: 'redis://:s3cr3t@h', unlink_batch: 0 })).not.toThrow(/s3cr3t/)
  })
})
