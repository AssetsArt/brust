import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  type FetchRequest,
  getActionsApp,
  readFramed,
  runFetch,
  setActionsApp,
  toRequest,
  writeFramed,
} from '../src/actions-bridge'
import type { StoreRecord } from '../src/store/core-adapter'
import { getServerInstance } from '../src/store/server-context'
import { type Handlers, makeDispatch, SLOT_BYTES } from '../src/worker'

const twoSlots = () => new Uint8Array(new SharedArrayBuffer(SLOT_BYTES * 2))
const dec = new TextDecoder()
const REQ = { method: 'POST', url: '/_brust/action/t?x=1', headers: {}, cookies: {}, search: {} }
const fr = (over: Partial<FetchRequest> = {}): FetchRequest => ({
  method: 'POST',
  url: '/_brust/action/t?x=1',
  headers: [['host', 'ex.com:8080']],
  body: null,
  req: REQ,
  ...over,
})
const mk = (): StoreRecord => ({ instance: {} })

afterEach(() => setActionsApp(null))

// ---- framing (A2) ----

test('writeFramed/readFramed round trip', () => {
  const view = twoSlots()
  const body = Uint8Array.from({ length: 256 }, (_, i) => i)
  const headers: [string, string][] = [
    ['content-type', 'application/octet-stream'],
    ['x-a', 'b'],
  ]
  const n = writeFramed(view, 1, 2, 201, headers, body)
  const { meta, body: got } = readFramed(view, 1, 2, n)
  expect(meta).toEqual({ status: 201, headers })
  expect([...got]).toEqual([...body])
  expect(view.subarray(0, SLOT_BYTES).every((b) => b === 0)).toBe(true)
})

// ---- toRequest (A1 → web Request) ----

test('toRequest: text body, no invented content-type', async () => {
  const r = toRequest(fr({ body: { text: '{"a":1}' } }))
  expect(await r.text()).toBe('{"a":1}')
  expect(r.headers.get('content-type')).toBeNull()
})

test('toRequest: b64 body is lossless', async () => {
  const r = toRequest(fr({ body: { b64: 'AAH/' } }))
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([0, 1, 255])
})

test('toRequest: null body → req.body === null; GET with a body → dropped, no throw', () => {
  expect(toRequest(fr()).body).toBeNull()
  const g = toRequest(fr({ method: 'GET', body: { text: 'x' } }))
  expect(g.method).toBe('GET')
  expect(g.body).toBeNull()
})

test('toRequest: R8 host rule', () => {
  expect(toRequest(fr()).url).toBe('http://ex.com:8080/_brust/action/t?x=1')
  expect(toRequest(fr({ headers: [['host', '[::1]:3000']] })).url).toBe('http://[::1]:3000/_brust/action/t?x=1')
  expect(toRequest(fr({ headers: [['host', 'a b']] })).url).toBe('http://localhost/_brust/action/t?x=1')
  expect(toRequest(fr({ headers: [['host', 'evil.com/x']] })).url).toBe('http://localhost/_brust/action/t?x=1')
  expect(toRequest(fr({ headers: [] })).url).toBe('http://localhost/_brust/action/t?x=1')
})

test('toRequest: repeated header pairs combine', () => {
  const r = toRequest(
    fr({
      headers: [
        ['x-dup', 'a'],
        ['x-dup', 'b'],
      ],
    }),
  )
  expect(r.headers.get('x-dup')).toBe('a, b')
})

// ---- runFetch ----

test('setActionsApp({}) throws TypeError; null unregisters', () => {
  expect(() => setActionsApp({} as never)).toThrow(TypeError)
  expect(() => setActionsApp({} as never)).toThrow(/fetch/)
  const a = { fetch: () => new Response('') }
  setActionsApp(a)
  expect(getActionsApp()).toBe(a)
  setActionsApp(null)
  expect(getActionsApp()).toBeNull()
})

test('echo; the frame carries no store (meta keys exactly status, headers)', async () => {
  setActionsApp({
    async fetch(req) {
      return new Response(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`, {
        status: 202,
        headers: { 'x-echo': '1' },
      })
    },
  })
  const view = twoSlots()
  const n = await runFetch(JSON.stringify(fr({ body: { text: 'hi' } })), view, 0, 2)
  const { meta, body } = readFramed(view, 0, 2, n)
  expect(Object.keys(meta)).toEqual(['status', 'headers'])
  expect(meta.status).toBe(202)
  expect(meta.headers).toContainEqual(['x-echo', '1'])
  expect(dec.decode(body)).toBe('POST /_brust/action/t hi')
})

test('two Set-Cookie survive', async () => {
  setActionsApp({
    fetch() {
      const h = new Headers()
      h.append('set-cookie', 'a=1')
      h.append('set-cookie', 'b=2')
      return new Response('ok', { headers: h })
    },
  })
  const view = twoSlots()
  const n = await runFetch(JSON.stringify(fr()), view, 1, 2)
  const cookies = readFramed(view, 1, 2, n).meta.headers.filter(([k]) => k === 'set-cookie')
  expect(cookies).toEqual([
    ['set-cookie', 'a=1'],
    ['set-cookie', 'b=2'],
  ])
})

test('fetch runs in a store scope', async () => {
  setActionsApp({
    fetch() {
      getServerInstance('s', mk)
      return new Response('in scope')
    },
  })
  const view = twoSlots()
  const n = await runFetch(JSON.stringify(fr()), view, 0, 2)
  const { meta, body } = readFramed(view, 0, 2, n)
  expect(meta.status).toBe(200)
  expect(dec.decode(body)).toBe('in scope')
  expect(() => getServerInstance('s', mk)).toThrow(/outside a request scope/)
})

test('two interleaved fetches see their own scope', async () => {
  setActionsApp({
    async fetch(req) {
      const id = new URL(req.url).searchParams.get('id') as string
      const rec = getServerInstance('who', () => ({ instance: { id } }))
      await Bun.sleep(id === 'slow' ? 20 : 1)
      return new Response((getServerInstance('who', mk).instance as { id: string }).id + (rec.instance as { id: string }).id)
    },
  })
  const view = twoSlots()
  const [a, b] = await Promise.all([
    runFetch(JSON.stringify(fr({ url: '/_brust/action/t?id=slow' })), view, 0, 2),
    runFetch(JSON.stringify(fr({ url: '/_brust/action/t?id=fast' })), view, 1, 2),
  ])
  expect(dec.decode(readFramed(view, 0, 2, a).body)).toBe('slowslow')
  expect(dec.decode(readFramed(view, 1, 2, b).body)).toBe('fastfast')
})

test('oversize body → 500 frame', async () => {
  setActionsApp({ fetch: () => new Response(new Uint8Array(SLOT_BYTES)) })
  const view = new Uint8Array(new SharedArrayBuffer(SLOT_BYTES))
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const n = await runFetch(JSON.stringify(fr()), view, 0, 1)
    const { meta, body } = readFramed(view, 0, 1, n)
    expect(meta).toEqual({ status: 500, headers: [['content-type', 'text/plain; charset=utf-8']] })
    expect(dec.decode(body)).toBe('brust: action response exceeds 262144 bytes')
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0]?.[0])).toMatch(/exceeds the 262144-byte slot/)
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^\[brust\] action response \d+ bytes exceeds the 262144-byte slot \(F82\) — answered 500$/)
  } finally {
    err.mockRestore()
  }
})

test('failures are 500 frames: no app, app throws, unparsable JSON', async () => {
  const view = twoSlots()
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    let n = await runFetch(JSON.stringify(fr()), view, 0, 2)
    let f = readFramed(view, 0, 2, n)
    expect(f.meta.status).toBe(500)
    expect(dec.decode(f.body)).toBe('brust: actions are not configured in this worker')

    setActionsApp({
      fetch() {
        throw new Error('boom')
      },
    })
    n = await runFetch(JSON.stringify(fr()), view, 0, 2)
    f = readFramed(view, 0, 2, n)
    expect(f.meta.status).toBe(500)
    expect(dec.decode(f.body)).toBe('brust: action failed')

    n = await runFetch('{not json', view, 1, 2)
    f = readFramed(view, 1, 2, n)
    expect(f.meta.status).toBe(500)
    expect(f.meta.headers).toEqual([['content-type', 'text/plain; charset=utf-8']])
  } finally {
    err.mockRestore()
  }
})

// ---- makeDispatch routes `fetch` to the bridge ----

test("makeDispatch(h, view, 1)('fetch', json, 0) answers a frame; loader/jobs never called", async () => {
  let called = 0
  const h: Handlers = {
    loader: async () => {
      called++
      return { error: 'no' }
    },
    jobs: async () => {
      called++
      return { results: [] }
    },
  }
  setActionsApp({ fetch: () => new Response('via dispatch', { status: 201 }) })
  const view = new Uint8Array(new SharedArrayBuffer(SLOT_BYTES))
  const n = await makeDispatch(h, view, 1)('fetch', JSON.stringify(fr()), 0)
  const metaLen = new DataView(view.buffer, 0, 4).getUint32(0, true)
  expect(metaLen).toBeLessThan(n)
  const { meta, body } = readFramed(view, 0, 1, n)
  expect(meta.status).toBe(201)
  expect(dec.decode(body)).toBe('via dispatch')
  expect(called).toBe(0)
})
