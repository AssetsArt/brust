import { afterAll, describe, expect, test } from 'bun:test'
import { INVAL_SCRIPT, SET_SCRIPT } from '../src/lua'
import { html, make, meta, servers, sweep } from './servers'

afterAll(sweep)

for (const [flavor, url] of servers()) {
  describe(`store (${flavor})`, () => {
    test('round trip keeps status, repeated headers and bytes', async () => {
      const a = await make(flavor, url)
      const body = new Uint8Array(256).map((_, i) => i)
      const headers: [string, string][] = [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['content-type', 'x/y']]
      const g0 = await a.store!.get('k1')
      expect(g0.page).toBeNull()
      expect(g0.stamp).toBe(0)
      expect(await a.store!.set('k1', { status: 201, headers, body }, meta({ tags: ['t'], stamp: g0.stamp }))).toBe(true)
      const g = await a.store!.get('k1')
      expect(g.page!.status).toBe(201)
      expect(g.page!.headers).toEqual(headers)
      expect(Array.from(g.page!.body)).toEqual(Array.from(body))
      expect(g.entryStamp).toBe(0)
      expect(g.storedAt).toBeGreaterThan(Date.now() - 5000)
    })

    test('a stale stamp is refused and its staging key is gone', async () => {
      const a = await make(flavor, url)
      const c = a.__test.client()
      const K = a.__test.keys()
      // The marker the invalidation leaves: seq 1 over tag "t".
      await c.send('SET', [K.markTag('t'), '1'])
      expect(await a.store!.set('k', html('x'), meta({ tags: ['t'], stamp: 0 }))).toBe(false)
      expect((await a.store!.get('k')).page).toBeNull()
      const stages = (await c.send('SCAN', ['0', 'MATCH', K.stage('*'), 'COUNT', '1000'])) as [string, string[]]
      expect(stages[1]).toEqual([])
      // A stamp at the marker passes (not older), and a path marker blocks the same way.
      expect(await a.store!.set('k', html('x'), meta({ tags: ['t'], stamp: 1 }))).toBe(true)
      await c.send('SET', [K.markPath('GET', '/p'), '5'])
      expect(await a.store!.set('k2', html('x'), meta({ path: '/p', stamp: 4 }))).toBe(false)
      expect(await a.store!.set('k2', html('x'), meta({ path: '/p', stamp: 5 }))).toBe(true)
    })

    test('F493: a prefix-scoped delete leaves the other prefix indexed; a prefix-alone delete clears its set', async () => {
      const a = await make(flavor, url)
      const c = a.__test.client()
      const K = a.__test.keys()
      await a.store!.set('pa', html('a'), meta({ tags: ['page'], path: '/p', prefix: 'a.test' }))
      await a.store!.set('pb', html('b'), meta({ tags: ['page'], path: '/p', prefix: 'b.test' }))
      await a.store!.set('qa', html('q'), meta({ path: '/q', prefix: 'a.test' }))
      expect((await c.send('SMEMBERS', [K.pfx('a.test')]) as string[]).sort()).toEqual([K.page('pa'), K.page('qa')].sort())
      await a.store!.invalidate({ prefix: 'a.test', path: '/p' })
      expect((await a.store!.get('pa')).page).toBeNull()
      expect((await a.store!.get('pb')).page).not.toBeNull()
      // b's member stays in the shared path set; a's left it and its prefix set (a dead member left in another index
      // set, here the tag set, only costs a no-op UNLINK later, as for every invalidation).
      expect(await c.send('SMEMBERS', [K.path('GET', '/p')])).toEqual([K.page('pb')])
      expect(await c.send('SMEMBERS', [K.pfx('a.test')])).toEqual([K.page('qa')])
      expect(await c.send('SMEMBERS', [K.pfx('b.test')])).toEqual([K.page('pb')])
      await a.store!.invalidate({ prefix: 'a.test' })
      expect((await a.store!.get('qa')).page).toBeNull()
      expect(Number(await c.send('EXISTS', [K.pfx('a.test')]))).toBe(0)
      expect((await a.store!.get('pb')).page).not.toBeNull()
      // A non-GET `{prefix, method}` deletes nothing (the store holds GET pages only).
      await a.store!.invalidate({ prefix: 'b.test', method: 'POST' })
      expect((await a.store!.get('pb')).page).not.toBeNull()
    })

    test('F493: a prefix + tags delete of more than one SREM batch drops every member', async () => {
      const a = await make(flavor, url)
      const N = 2100
      await Promise.all(Array.from({ length: N }, (_, i) => a.store!.set(`m${i}`, html('x'), meta({ tags: ['big'], path: `/m${i}`, prefix: i % 2 ? 'a.test' : 'b.test' }))))
      await a.store!.invalidate({ prefix: 'a.test', tags: ['big'] })
      const got = await Promise.all(Array.from({ length: N }, (_, i) => a.store!.get(`m${i}`)))
      expect(got.filter((g, i) => (g.page === null) !== (i % 2 === 1)).length).toBe(0)
      expect(Number(await a.__test.client().send('SCARD', [a.__test.keys().tag('big')]))).toBe(N / 2)
    })

    test('an unguarded write (stamp null) ignores markers', async () => {
      const a = await make(flavor, url)
      await a.__test.client().send('SET', [a.__test.keys().markTag('t'), '99'])
      expect(await a.store!.set('k', html('x'), meta({ tags: ['t'], stamp: null }))).toBe(true)
      expect((await a.store!.get('k')).entryStamp).toBeNull()
    })

    test('the index TTL is extended to the longest member and pages expire', async () => {
      const a = await make(flavor, url)
      const c = a.__test.client()
      const K = a.__test.keys()
      await a.store!.set('short', html('x'), meta({ tags: ['t'], ttlMs: 2000 }))
      const t1 = Number(await c.send('PTTL', [K.tag('t')]))
      await a.store!.set('long', html('y'), meta({ tags: ['t'], ttlMs: 20_000 }))
      const t2 = Number(await c.send('PTTL', [K.tag('t')]))
      expect(t1).toBeGreaterThan(0)
      expect(t1).toBeLessThanOrEqual(2000)
      expect(t2).toBeGreaterThan(2000)
      expect(Number(await c.send('PTTL', [K.page('short')]))).toBeLessThanOrEqual(2000)
      expect(new Set(((await c.send('SMEMBERS', [K.tag('t')])) as string[]))).toEqual(new Set([K.page('short'), K.page('long')]))
    })

    test('a 1 MiB body round trips; one over max_body_bytes is refused without I/O', async () => {
      const a = await make(flavor, url, { max_body_bytes: 1_048_576 })
      const big = new Uint8Array(1_048_576).map((_, i) => i % 251)
      expect(await a.store!.set('big', html(big), meta())).toBe(true)
      expect(Array.from((await a.store!.get('big')).page!.body.subarray(0, 300))).toEqual(Array.from(big.subarray(0, 300)))
      expect((await a.store!.get('big')).page!.body.length).toBe(1_048_576)
      expect(await a.store!.set('over', html(new Uint8Array(1_048_577)), meta())).toBe(false)
      expect((await a.store!.get('over')).page).toBeNull()
    })

    test('after SCRIPT FLUSH the next set succeeds (NOSCRIPT → EVAL) and the script is cached again', async () => {
      const a = await make(flavor, url)
      const c = a.__test.client()
      await c.send('SCRIPT', ['FLUSH'])
      expect(await c.send('SCRIPT', ['EXISTS', SET_SCRIPT.sha])).toEqual([0])
      expect(await a.store!.set('k', html('x'), meta({ tags: ['t'], stamp: 0 }))).toBe(true)
      expect(await c.send('SCRIPT', ['EXISTS', SET_SCRIPT.sha])).toEqual([1])
      expect(INVAL_SCRIPT.sha).toMatch(/^[0-9a-f]{40}$/)
    })

    test('a page whose meta v is 2 makes get throw', async () => {
      const a = await make(flavor, url)
      const m = new TextEncoder().encode(JSON.stringify({ v: 2 }))
      const b = new Uint8Array(4 + m.length)
      new DataView(b.buffer).setUint32(0, m.length, true)
      b.set(m, 4)
      await a.__test.client().set(a.__test.keys().page('v2'), b)
      await expect(a.store!.get('v2')).rejects.toThrow('unknown frame version')
    })
  })
}
