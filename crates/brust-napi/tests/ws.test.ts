// F529 ws-napi (plan §2c) through the real addon: a worker registered with `registerWorker` accepts the upgrade `fetch`
// with `101` + `ws`, its `registerSockets` handler hears the events, and the `ws*` calls drive the sockets. The server
// is started from `startOptions` (run.ts) with a non-default `[actions.ws]`, which must reach Rust.
// Run alone: `bun test --timeout 60000 crates/brust-napi/tests/ws.test.ts` (needs `packages/brust/native` built).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { BrustConfig } from '../../../packages/brust/src/config'
import { startOptions } from '../../../packages/brust/src/run'
import {
  beginDrain,
  localAddr,
  registerSockets,
  registerWorker,
  startServer,
  untilReady,
  wsClose,
  wsIsSubscribed,
  wsPing,
  wsPublish,
  wsRemoteAddress,
  wsSend,
  wsSubscribe,
  wsSubscriptions,
  wsTerminate,
  wsUnsubscribe,
} from '../../../packages/brust/native/index.js'

const dist = resolve(import.meta.dir, '../../brust-server/tests/fixtures/dist')
const PATH = '/_brust/action/live'
const SLOTS = 2
const sab = new Uint8Array(new SharedArrayBuffer(256 * 1024 * SLOTS))
const sub = Math.floor(sab.length / SLOTS)
const enc = new TextEncoder()

/** The A2 frame `[u32 LE meta_len][meta][body]`, written into `slot`; resolves with its length. */
function frame(slot: number, meta: object, body = new Uint8Array()): number {
  const m = enc.encode(JSON.stringify(meta))
  const at = slot * sub
  new DataView(sab.buffer).setUint32(at, m.length, true)
  sab.set(m, at + 4)
  sab.set(body, at + 4 + m.length)
  return 4 + m.length + body.length
}

type Ev = { id: number; ev: string; data: string | Buffer | null; code: number; reason: string }
const events: Ev[] = []
let nextId = 1
let worker = -1
/** What the socket handler does with a message (set per test). */
let onMessage: (id: number, data: string | Buffer) => Promise<void> | void = (id, d) => {
  wsSend(worker, id, d)
}

const handler = async (kind: string, requestJson: string, slot: number) => {
  if (kind !== 'fetch') throw new Error(`unexpected ${kind}`)
  const req = JSON.parse(requestJson)
  if (req.headers.some(([k]: [string]) => k === 'x-deny')) return frame(slot, { status: 401, headers: [] }, enc.encode('no'))
  return frame(slot, { status: 101, headers: [['set-cookie', 'sid=1']], ws: { id: nextId++ } })
}

let base = ''
beforeAll(async () => {
  const cfg = { host: '127.0.0.1', port: 0, workers: 1, callTimeoutMs: 5000, ioThreads: 2 } as unknown as BrustConfig
  const opts = startOptions(
    cfg,
    dist,
    {
      actions: {
        entry: 'actions.js',
        prefix: '/_brust/action',
        maxBodyBytes: 1048576,
        ws: { enabled: true, maxPayloadBytes: 4096, idleTimeoutS: 0, pingIntervalS: 0, maxConnections: 100, backpressureBytes: 1048576 },
      },
    },
    'test',
  )
  // run.ts forwards [actions.ws] as it is
  expect(opts.actions?.ws).toEqual({ enabled: true, maxPayloadBytes: 4096, idleTimeoutS: 0, pingIntervalS: 0, maxConnections: 100, backpressureBytes: 1048576 })
  startServer(opts)
  worker = registerWorker(sab, SLOTS, handler)
  registerSockets(worker, (id, ev, data, code, reason) => {
    events.push({ id, ev, data, code, reason })
    if (ev === 'message' && data !== null) return onMessage(id, data)
  })
  await untilReady(5000)
  base = `ws://${localAddr()}`
})

afterAll(async () => {
  await beginDrain(2000)
})

async function until(what: string, f: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (f()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A connected client and the socket id the worker gave it. */
async function open(headers: Record<string, string> = {}): Promise<{ ws: WebSocket; id: number; got: (string | ArrayBuffer)[] }> {
  const before = events.filter((e) => e.ev === 'open').length
  const ws = new WebSocket(`${base}${PATH}`, { headers } as never)
  ws.binaryType = 'arraybuffer'
  const got: (string | ArrayBuffer)[] = []
  ws.onmessage = (m) => got.push(m.data as string | ArrayBuffer)
  await new Promise<void>((ok, bad) => {
    ws.onopen = () => ok()
    ws.onerror = () => bad(new Error('ws error'))
  })
  await until('the open event', () => events.filter((e) => e.ev === 'open').length > before)
  const id = events.filter((e) => e.ev === 'open').at(-1)!.id
  return { ws, id, got }
}

const of = (id: number) => events.filter((e) => e.id === id)

test('text and binary reach the handler as string and Buffer; wsSend answers bytes and echoes', async () => {
  const c = await open()
  c.ws.send('hi')
  c.ws.send(new Uint8Array([0, 1, 255]))
  await until('two echoes', () => c.got.length === 2)
  expect(c.got[0]).toBe('hi')
  expect([...new Uint8Array(c.got[1] as ArrayBuffer)]).toEqual([0, 1, 255])
  const msgs = of(c.id).filter((e) => e.ev === 'message')
  expect(msgs[0].data).toBe('hi')
  expect(Buffer.isBuffer(msgs[1].data)).toBe(true)
  expect([...(msgs[1].data as Buffer)]).toEqual([0, 1, 255])
  expect(wsSend(worker, c.id, 'four')).toBe(4)
  expect(wsSend(worker, c.id, Buffer.from([1, 2]))).toBe(2)
  expect(wsSend(worker, 999_999, 'x')).toBe(0)
  expect(wsRemoteAddress(worker, c.id)).toBe('127.0.0.1')
  expect(wsRemoteAddress(worker, 999_999)).toBe('')
  // the client closes: the handler hears its code and reason
  c.ws.close(4001, 'bye')
  await until('the close event', () => of(c.id).some((e) => e.ev === 'close'))
  expect(of(c.id).find((e) => e.ev === 'close')).toMatchObject({ code: 4001, reason: 'bye', data: null })
  expect(of(c.id)[0].ev).toBe('open')
  expect(wsSend(worker, c.id, 'late')).toBe(0)
})

test('topics: subscribe, publish with and without except, unsubscribe', async () => {
  const a = await open()
  const b = await open()
  expect(wsSubscribe(worker, a.id, 'room')).toBe(true)
  expect(wsSubscribe(worker, b.id, 'room')).toBe(true)
  expect(wsSubscribe(worker, b.id, 'other')).toBe(true)
  expect(wsIsSubscribed(worker, a.id, 'room')).toBe(true)
  expect(wsSubscriptions(worker, b.id)).toEqual(['other', 'room'])
  // a publishes: b gets it, a does not
  expect(wsPublish('room', 'from a', worker, a.id)).toBe(6)
  await until('b got it', () => b.got.includes('from a'))
  // a server-level publish reaches both
  expect(wsPublish('room', Buffer.from('all'))).toBe(6)
  await until('both got it', () => a.got.length === 1 && b.got.length === 2)
  expect(a.got).toHaveLength(1)
  expect(wsUnsubscribe(worker, b.id, 'room')).toBe(true)
  expect(wsUnsubscribe(worker, b.id, 'room')).toBe(false)
  expect(wsPublish('room', 'x', worker, a.id)).toBe(0)
  expect(wsPublish('nobody', 'x')).toBe(0)
  a.ws.close()
  b.ws.close()
})

test('the server closes, terminates and pings; the handler hears pong', async () => {
  const a = await open()
  const closed = new Promise<CloseEvent>((ok) => {
    a.ws.onclose = ok
  })
  wsClose(worker, a.id, 4002, 'done')
  const ce = await closed
  expect([ce.code, ce.reason]).toEqual([4002, 'done'])
  await until('the close event', () => of(a.id).some((e) => e.ev === 'close'))
  expect(of(a.id).find((e) => e.ev === 'close')).toMatchObject({ code: 4002, reason: 'done' })

  const b = await open()
  wsPing(worker, b.id, Buffer.from('p'))
  await until('the pong event', () => of(b.id).some((e) => e.ev === 'pong'))
  expect(String(of(b.id).find((e) => e.ev === 'pong')!.data)).toBe('p')
  const gone = new Promise<CloseEvent>((ok) => {
    b.ws.onclose = ok
  })
  wsTerminate(worker, b.id)
  expect((await gone).code).toBe(1006)
  await until('the close event', () => of(b.id).some((e) => e.ev === 'close'))
  expect(of(b.id).find((e) => e.ev === 'close')).toMatchObject({ code: 1006 })
})

test('a Promise from the handler is awaited in order; a throwing handler does not stop the socket', async () => {
  const seen: string[] = []
  onMessage = async (id, d) => {
    if (d === 'boom') throw new Error('handler failed')
    await Bun.sleep(d === 'slow' ? 100 : 0)
    seen.push(String(d))
    wsSend(worker, id, `ok ${d}`)
  }
  try {
    const c = await open()
    for (const m of ['slow', 'boom', 'fast']) c.ws.send(m)
    await until('two answers', () => c.got.length === 2)
    // `deliver` is called in order: the slow one started first
    expect(of(c.id).filter((e) => e.ev === 'message').map((e) => e.data)).toEqual(['slow', 'boom', 'fast'])
    expect(c.got.sort()).toEqual(['ok fast', 'ok slow'])
    c.ws.send('again')
    await until('the socket still works', () => c.got.includes('ok again'))
    c.ws.close()
  } finally {
    onMessage = (id, d) => {
      wsSend(worker, id, d)
    }
  }
})

test('the non-default [actions.ws] reached the server: a message over 4096 bytes closes with 1009', async () => {
  const c = await open()
  const closed = new Promise<CloseEvent>((ok) => {
    c.ws.onclose = ok
  })
  c.ws.send('x'.repeat(4096))
  await until('the echo of the limit', () => c.got.length === 1)
  c.ws.send('x'.repeat(4097))
  expect((await closed).code).toBe(1009)
})

test('a route refusal keeps its status and opens nothing', async () => {
  const opens = events.filter((e) => e.ev === 'open').length
  const r = await fetch(`http${base.slice(2)}${PATH}`, {
    headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'x-deny': '1' },
  })
  expect(r.status).toBe(401)
  await Bun.sleep(50)
  expect(events.filter((e) => e.ev === 'open').length).toBe(opens)
})
