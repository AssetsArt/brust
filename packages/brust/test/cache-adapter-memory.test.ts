import { describe, expect, test } from 'bun:test'
import { memoryAdapter } from '../src/cache-adapter'
import { runConformance } from '../src/cache-adapter/conformance'

describe('memory push', () => runConformance(() => memoryAdapter({ broadcast: 'push' }), { push: true, guard: true }))
describe('memory pull', () => runConformance(() => memoryAdapter({ broadcast: 'pull' }), { pull: true, guard: true }))
describe('memory, no broadcast', () => runConformance(() => memoryAdapter({ broadcast: 'none' })))

describe('memory adapter specifics', () => {
  test('regen changes gen and forces readers behind', async () => {
    const a = memoryAdapter({ broadcast: 'pull' })
    await a.broadcast!.publish({ tags: ['a'] }, 'o')
    const r1 = await a.broadcast!.since!(0)
    a.__test.regen()
    const r2 = await a.broadcast!.since!(0)
    expect(r2.gen).not.toBe(r1.gen)
    expect(r2.behind).toBe(true)
  })

  test('the ring is bounded by bytes: the oldest events drop first', async () => {
    const a = memoryAdapter({ broadcast: 'pull', ringBytes: 4096 })
    const b = a.broadcast!
    for (let i = 0; i < 40; i++) await b.publish({ tags: [`tag-${'x'.repeat(100)}-${i}`] }, 'o')
    expect((await b.since!(0)).behind).toBe(true)
    const recent = await b.since!(38)
    expect(recent.behind).toBe(false)
    expect(recent.events.map(e => e.seq)).toEqual([39, 40])
  })

  test('an oversize event is a gap marker: readers across it are behind', async () => {
    const a = memoryAdapter({ broadcast: 'pull' })
    const b = a.broadcast!
    await b.publish({ tags: ['ok'] }, 'o')
    await b.publish({ tags: ['x'.repeat(70 * 1024)] }, 'o')
    await b.publish({ tags: ['after'] }, 'o')
    expect((await b.since!(1)).behind).toBe(true)
    expect((await b.since!(2)).events.map(e => e.args.tags)).toEqual([['after']])
  })

  test('a store without a broadcast reports null stamps and writes unguarded', async () => {
    const a = memoryAdapter({ broadcast: 'none' })
    expect(a.broadcast).toBeUndefined()
    const g = await a.store.get('k')
    expect(g.stamp).toBeNull()
    await a.store.invalidate({ tags: ['t'] })
    expect(await a.store.set('k', { status: 200, headers: [], body: new Uint8Array(1) }, { ttlMs: 1000, tags: ['t'], method: 'GET', path: '/', stamp: null })).toBe(true)
  })

  test('hangNextGet and failNext', async () => {
    const a = memoryAdapter()
    a.__test.hangNextGet(30)
    const t0 = Date.now()
    expect((await a.store.get('k')).page).toBeNull()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    a.__test.failNext()
    await expect(a.store.get('k')).rejects.toThrow('injected failure')
    expect(a.__test.publishCount()).toBe(0)
  })
})
