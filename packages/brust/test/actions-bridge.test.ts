import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  type FetchRequest,
  getActionsApp,
  pulledBody,
  readFramed,
  type HeapIo,
  runFetch,
  setActionsApp,
  setActionsLimits,
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

afterEach(() => {
  setActionsApp(null)
  setActionsLimits({ maxResponseBytes: 8_388_608 })
})

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

// ---- heap transfer (F82, R1/R2/R5/R8) ----

const TP: [string, string][] = [['content-type', 'text/plain; charset=utf-8']]
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)
const mkIo = (over: Partial<HeapIo> = {}) => {
  const putCalls: { slot: number; body: Uint8Array }[] = []
  const io: HeapIo = {
    takeBody: () => null,
    putReply: (slot, body) => {
      putCalls.push({ slot, body })
      return true
    },
    ...over,
  }
  return { io, putCalls }
}
const quiet = () => spyOn(console, 'error').mockImplementation(() => {})

test('heap request body: the app sees byte-equal arrayBuffer()', async () => {
  const want = bytes(300_000)
  let got: Uint8Array | null = null
  setActionsApp({
    async fetch(req) {
      got = new Uint8Array(await req.arrayBuffer())
      return new Response('ok')
    },
  })
  const view = twoSlots()
  const { io } = mkIo({ takeBody: (slot) => (slot === 1 ? want : null) })
  const n = await runFetch(JSON.stringify(fr({ body: { heap: 300_000 } })), view, 1, 2, io)
  expect(readFramed(view, 1, 2, n).meta.status).toBe(200)
  expect(got).not.toBeNull()
  expect(Buffer.from(got as unknown as Uint8Array).equals(Buffer.from(want))).toBe(true)
})

test('heap request body missing or of the wrong length → 500 brust: action failed + one log', async () => {
  setActionsApp({ fetch: () => new Response('never') })
  for (const taken of [null, bytes(10)]) {
    const view = twoSlots()
    const err = quiet()
    try {
      const n = await runFetch(JSON.stringify(fr({ body: { heap: 300_000 } })), view, 0, 2, mkIo({ takeBody: () => taken }).io)
      const f = readFramed(view, 0, 2, n)
      expect(f.meta).toEqual({ status: 500, headers: TP })
      expect(dec.decode(f.body)).toBe('brust: action failed')
      expect(err).toHaveBeenCalledTimes(1)
    } finally {
      err.mockRestore()
    }
  }
})

test('300 KiB response: putReply once with the body; meta carries heap, slot body empty', async () => {
  const body = bytes(307_200)
  setActionsApp({ fetch: () => new Response(body, { headers: { 'x-a': 'b' } }) })
  const view = twoSlots()
  const { io, putCalls } = mkIo()
  const n = await runFetch(JSON.stringify(fr()), view, 1, 2, io)
  expect(putCalls).toHaveLength(1)
  expect(putCalls[0]?.slot).toBe(1)
  expect(Buffer.from(putCalls[0]?.body as Uint8Array).equals(Buffer.from(body))).toBe(true)
  const f = readFramed(view, 1, 2, n)
  expect(f.meta).toEqual({ status: 200, headers: [...(f.meta.headers as [string, string][])], heap: 307_200 })
  expect(f.meta.headers.some(([k, v]) => k === 'x-a' && v === 'b')).toBe(true)
  expect(f.body.length).toBe(0)
})

test('response over max_response_bytes: putReply NOT called; 500 with the R8 text and log line', async () => {
  setActionsApp({ fetch: () => new Response(new Uint8Array(262_145)) })
  setActionsLimits({ maxResponseBytes: 262_144 })
  const view = twoSlots()
  const { io, putCalls } = mkIo()
  const err = quiet()
  try {
    const n = await runFetch(JSON.stringify(fr()), view, 0, 2, io)
    const f = readFramed(view, 0, 2, n)
    expect(f.meta).toEqual({ status: 500, headers: TP })
    expect(dec.decode(f.body)).toBe('brust: action response exceeds 262144 bytes')
    expect(putCalls).toHaveLength(0)
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0]?.[0])).toBe('[brust] action response body 262145 bytes exceeds max_response_bytes 262144 — answered 500')
  } finally {
    err.mockRestore()
  }
})

test('putReply returns false → 500 brust: action failed', async () => {
  setActionsApp({ fetch: () => new Response(new Uint8Array(300_000)) })
  const view = twoSlots()
  const err = quiet()
  try {
    const n = await runFetch(JSON.stringify(fr()), view, 0, 2, mkIo({ putReply: () => false }).io)
    const f = readFramed(view, 0, 2, n)
    expect(f.meta).toEqual({ status: 500, headers: TP })
    expect(dec.decode(f.body)).toBe('brust: action failed')
    expect(err).toHaveBeenCalledTimes(1)
  } finally {
    err.mockRestore()
  }
})

test('a response that fits the slot: no putReply, slot bytes equal today\'s writeFramed output', async () => {
  const body = bytes(1000)
  setActionsApp({ fetch: () => new Response(body, { headers: { 'content-type': 'application/octet-stream' } }) })
  const view = twoSlots()
  const { io, putCalls } = mkIo()
  const n = await runFetch(JSON.stringify(fr()), view, 1, 2, io)
  expect(putCalls).toHaveLength(0)
  const f = readFramed(view, 1, 2, n)
  const ref = twoSlots()
  const m = writeFramed(ref, 1, 2, f.meta.status, f.meta.headers, body)
  expect(n).toBe(m)
  expect(Buffer.from(view.subarray(SLOT_BYTES, SLOT_BYTES + n)).equals(Buffer.from(ref.subarray(SLOT_BYTES, SLOT_BYTES + m)))).toBe(true)
  expect(Object.keys(f.meta)).toEqual(['status', 'headers'])
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

// ---- streamed request body (F475) ----

/** A pull channel over `chunks`, then `end` (null = a clean end, a string = the failure reason); records the pulls. */
const puller = (chunks: Uint8Array[], end: string | null = null) => {
  const calls: { slot: number; token: number }[] = []
  let i = 0
  const pullBody = async (slot: number, token: number) => {
    calls.push({ slot, token })
    return i < chunks.length ? chunks[i++]! : end
  }
  return { pullBody, calls }
}

test('streamed body: the app reads every chunk in order; pulls carry the slot and the token', async () => {
  const parts = [bytes(1000), bytes(70_000), bytes(5)]
  let got: Uint8Array | null = null
  setActionsApp({
    async fetch(req) {
      got = new Uint8Array(await req.arrayBuffer())
      return new Response('ok')
    },
  })
  const view = twoSlots()
  const { pullBody, calls } = puller(parts)
  const n = await runFetch(JSON.stringify(fr({ body: { stream: { length: 71_005, token: 7 } } })), view, 1, 2, mkIo({ pullBody }).io)
  expect(readFramed(view, 1, 2, n).meta.status).toBe(200)
  expect(Buffer.from(got as unknown as Uint8Array).equals(Buffer.concat(parts))).toBe(true)
  expect(calls).toEqual(Array.from({ length: 4 }, () => ({ slot: 1, token: 7 })))
})

test('streamed body: nothing is pulled before the app reads, and only one chunk ahead of each read', async () => {
  const { pullBody, calls } = puller([bytes(3), bytes(4)])
  const body = pulledBody(() => pullBody(0, 1))
  await Bun.sleep(5)
  expect(calls).toHaveLength(0)
  const r = body.getReader()
  expect((await r.read()).value?.length).toBe(3)
  await Bun.sleep(5)
  expect(calls).toHaveLength(1)
  expect((await r.read()).value?.length).toBe(4)
  expect((await r.read()).done).toBe(true)
})

test('streamed body: a failed pull rejects the app read with a TypeError naming the bound', async () => {
  for (const [why, msg] of [
    ['max_stream_bytes', 'exceeds max_stream_bytes'],
    ['idle', 'stalled longer than stream_idle_ms'],
    ['io', 'broke off or ended short'],
  ] as const) {
    const { pullBody } = puller([bytes(2)], why)
    const r = pulledBody(() => pullBody(0, 1)).getReader()
    await r.read()
    const e = await r.read().then(
      () => null,
      (x) => x as Error,
    )
    expect(e).toBeInstanceOf(TypeError)
    expect(e?.message).toContain(msg)
  }
})

test('streamed body without a pull channel → 500 brust: action failed', async () => {
  setActionsApp({ fetch: () => new Response('never') })
  const view = twoSlots()
  const err = quiet()
  try {
    const n = await runFetch(JSON.stringify(fr({ body: { stream: { length: null, token: 1 } } })), view, 0, 2, mkIo().io)
    expect(readFramed(view, 0, 2, n).meta.status).toBe(500)
  } finally {
    err.mockRestore()
  }
})
