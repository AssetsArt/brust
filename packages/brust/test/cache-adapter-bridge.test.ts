// The native `cache` call kind's worker side (runCache): every outcome is an A2 frame.
import { expect, test } from 'bun:test'
import { type HeapIo, readFramed } from '../src/actions-bridge'
import { memoryAdapter } from '../src/cache-adapter'
import { type CacheBridgeDeps, runCache } from '../src/cache-adapter/bridge'

const SLOT = 4096
const enc = new TextEncoder()

function io(body: Uint8Array | null = null, acceptPut = true) {
  const put: Uint8Array[] = []
  const h: HeapIo = { takeBody: () => body, putReply: (_s, b) => (acceptPut ? (put.push(b), true) : false) }
  return { h, put }
}

async function call(req: object, deps: Partial<CacheBridgeDeps> & { store: CacheBridgeDeps['store'] }, heap = io()) {
  const view = new Uint8Array(SLOT * 2)
  const counted: string[] = []
  const d: CacheBridgeDeps = { getTimeoutMs: 100, maxBodyBytes: 1 << 20, count: (n) => counted.push(n), ...deps }
  const n = await runCache(JSON.stringify(req), view, 1, 2, heap.h, d)
  const f = readFramed(view, 1, 2, n)
  return { meta: f.meta as unknown as Record<string, unknown>, body: f.body, counted, put: heap.put }
}

const setMeta = { ttlMs: 60_000, tags: ['t'], method: 'GET', path: '/a', stamp: 0 }

test('get miss carries the stamp', async () => {
  const a = memoryAdapter()
  const r = await call({ op: 'get', key: 'k' }, { store: a.store })
  expect(r.meta).toEqual({ hit: false, stamp: 0 })
})

test('get hit is framed with status, headers, stamps and the body', async () => {
  const a = memoryAdapter()
  await a.store.set('k', { status: 200, headers: [['content-type', 'text/html'], ['x-a', '1'], ['x-a', '2']], body: enc.encode('<p>hi</p>') }, setMeta)
  const r = await call({ op: 'get', key: 'k' }, { store: a.store })
  expect(r.meta).toMatchObject({ hit: true, status: 200, headers: [['content-type', 'text/html'], ['x-a', '1'], ['x-a', '2']], stamp: 0, entryStamp: 0 })
  expect(typeof r.meta.storedAt).toBe('number')
  expect(new TextDecoder().decode(r.body)).toBe('<p>hi</p>')
})

test('a hit too large for the slot leaves by putReply (heap)', async () => {
  const a = memoryAdapter()
  const big = new Uint8Array(10_000).fill(7)
  await a.store.set('k', { status: 200, headers: [], body: big }, setMeta)
  const r = await call({ op: 'get', key: 'k' }, { store: a.store })
  expect(r.meta).toMatchObject({ hit: true, heap: 10_000 })
  expect(r.body.length).toBe(0)
  expect(r.put[0]).toEqual(big)
})

test('a declined heap put is a miss and an error', async () => {
  const a = memoryAdapter()
  await a.store.set('k', { status: 200, headers: [], body: new Uint8Array(10_000) }, setMeta)
  const r = await call({ op: 'get', key: 'k' }, { store: a.store }, io(null, false))
  expect(r.meta).toEqual({ hit: false, stamp: 0 })
  expect(r.counted).toEqual(['errors'])
})

test('a hit over maxBodyBytes is a miss and an error', async () => {
  const a = memoryAdapter()
  await a.store.set('k', { status: 200, headers: [], body: new Uint8Array(100) }, setMeta)
  const r = await call({ op: 'get', key: 'k' }, { store: a.store, maxBodyBytes: 10 })
  expect(r.meta).toEqual({ hit: false, stamp: 0 })
  expect(r.counted).toEqual(['errors'])
})

test('a hung get settles at getTimeoutMs with an error frame', async () => {
  const a = memoryAdapter()
  a.__test.hangNextGet(5000)
  const t0 = Date.now()
  const r = await call({ op: 'get', key: 'k' }, { store: a.store, getTimeoutMs: 30 })
  expect(r.meta).toEqual({ error: 'get timed out' })
  expect(Date.now() - t0).toBeLessThan(1000)
})

test('a throwing store is an error frame', async () => {
  const a = memoryAdapter()
  a.__test.failNext()
  const r = await call({ op: 'get', key: 'k' }, { store: a.store })
  expect(String(r.meta.error)).toContain('injected failure')
})

test('set takes the heap body and answers ok', async () => {
  const a = memoryAdapter()
  const body = enc.encode('<p>x</p>')
  const r = await call({ op: 'set', key: 'k', status: 200, headers: [['content-type', 'text/html']], meta: setMeta, heap: body.length }, { store: a.store }, io(body))
  expect(r.meta).toEqual({ ok: true })
  expect((await a.store.get('k')).page?.body).toEqual(body)
})

test('a refused set (stale stamp) answers ok:false', async () => {
  const a = memoryAdapter()
  await a.store.invalidate({ tags: ['t'] })
  const body = enc.encode('x')
  const r = await call({ op: 'set', key: 'k', status: 200, headers: [], meta: setMeta, heap: 1 }, { store: a.store }, io(body))
  expect(r.meta).toEqual({ ok: false })
})

test('a set whose heap body length mismatches is an error frame', async () => {
  const a = memoryAdapter()
  const r = await call({ op: 'set', key: 'k', status: 200, headers: [], meta: setMeta, heap: 5 }, { store: a.store }, io(enc.encode('xy')))
  expect(String(r.meta.error)).toContain('2 != 5')
  const m = await call({ op: 'set', key: 'k', status: 200, headers: [], meta: setMeta, heap: 5 }, { store: a.store }, io(null))
  expect(String(m.meta.error)).toContain('missing')
})

test('no store and an unknown op are error frames', async () => {
  expect((await call({ op: 'get', key: 'k' }, { store: undefined })).meta).toEqual({ error: 'no cache adapter store in this worker' })
  expect(String((await call({ op: 'nope' }, { store: memoryAdapter().store })).meta.error)).toContain('unknown cache op')
})
