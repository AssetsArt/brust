// F529 ws-adapter: Elysia `.ws()` under brust() against a fake napi module (plan §2c). No Rust, no addon.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { websocket } from 'elysia/websocket'
import { fetchParts, readFramed, runFetch } from '../src/actions-bridge'
import { brust, setWebSocketCapability } from '../src/actions/elysia'
import { mountActions, startActionSockets } from '../src/actions/load'
import { type SocketEventFn, setWsNative, socketCount, type WsNative } from '../src/actions/ws'

interface Call { fn: string; args: unknown[] }
let calls: Call[]
let events: SocketEventFn | undefined
let sendCode = 1
let subs: Map<string, Set<string>>
const fake: WsNative = {
  registerSockets: (_w, fn) => void (events = fn),
  wsSend: (...args) => (calls.push({ fn: 'send', args: args.slice(2) }), sendCode),
  wsClose: (...args) => void calls.push({ fn: 'close', args: args.slice(2) }),
  wsTerminate: (...args) => void calls.push({ fn: 'terminate', args: args.slice(2) }),
  wsSubscribe: (_w, l, topic) => (calls.push({ fn: 'subscribe', args: [topic] }), (subs.get(`${l}`) ?? subs.set(`${l}`, new Set()).get(`${l}`)!).add(topic), true),
  wsUnsubscribe: (_w, l, topic) => (calls.push({ fn: 'unsubscribe', args: [topic] }), subs.get(`${l}`)?.delete(topic) ?? false),
  wsIsSubscribed: (_w, l, topic) => subs.get(`${l}`)?.has(topic) ?? false,
  wsSubscriptions: (_w, l) => [...(subs.get(`${l}`) ?? [])],
  wsPing: (...args) => void calls.push({ fn: 'ping', args: args.slice(2) }),
  wsPong: (...args) => void calls.push({ fn: 'pong', args: args.slice(2) }),
  wsRemoteAddress: () => '203.0.113.7:4455',
  wsPublish: (...args) => (calls.push({ fn: 'publish', args }), 3),
}

beforeEach(() => {
  calls = []
  events = undefined
  sendCode = 1
  subs = new Map()
  setWsNative(fake)
  setWebSocketCapability(websocket)
})
afterEach(() => {
  setWsNative(null)
  setWebSocketCapability(null)
})

const up = (path = '/ws', headers: Record<string, string> = {}) =>
  new Request(`http://l${path}`, { headers: { upgrade: 'websocket', connection: 'upgrade', ...headers } })
const mount = (app: Elysia, prefix = '/api') => mountActions(app, prefix)

/** Drives the whole upgrade through the bridge's `fetchParts`, then opens the socket the way Rust would. */
async function connect(app: Elysia, path = '/api/ws', headers?: Record<string, string>) {
  const outer = mount(app)
  expect(startActionSockets(outer, 2)).toBe(true)
  const out = await fetchParts(outer, up(path, headers))
  return { outer, out }
}

test('a .ws() route upgrades: fetchParts answers 101 with the ws meta and the upgrade headers', async () => {
  const { out } = await connect(new Elysia({ adapter: brust() }).ws('/ws', { message() {} }))
  expect(out.status).toBe(101)
  expect(out.ws?.id).toBeGreaterThan(0)
  expect(socketCount()).toBeGreaterThan(0)
})

test('A2 frame: runFetch writes status 101 and ws.id', async () => {
  const outer = mount(new Elysia({ adapter: brust() }).ws('/ws', { message() {} }))
  const view = new Uint8Array(65536)
  const setup = (await import('../src/actions-bridge')).setActionsApp
  setup(outer)
  try {
    const n = await runFetch(JSON.stringify({ method: 'GET', url: '/api/ws', headers: [['upgrade', 'websocket'], ['host', 'l']], body: null, req: {} }), view, 0, 1)
    const { meta } = readFramed(view, 0, 1, n)
    expect(meta.status).toBe(101)
    expect(meta.ws?.id).toBeGreaterThan(0)
  } finally {
    setup(null)
  }
})

test('open/message/close reach the Elysia handlers with ws.send mapped to wsSend', async () => {
  const log: string[] = []
  const app = new Elysia({ adapter: brust() }).ws('/ws', {
    open(ws) { log.push('open'); ws.send('hi') },
    message(ws, m) { log.push(`msg:${String(m)}`); ws.send(`echo:${String(m)}`) },
    close(_ws, code, reason) { log.push(`close:${code}:${reason}`) },
  })
  const held = socketCount()
  const { out } = await connect(app)
  expect(socketCount()).toBe(held + 1)
  const id = out.ws!.id
  await events!(id, 'open', null, 0, '')
  await events!(id, 'message', 'yo', 0, '')
  await events!(id, 'close', null, 1000, 'bye')
  expect(log).toEqual(['open', 'msg:yo', 'close:1000:bye'])
  expect(calls.filter((c) => c.fn === 'send').map((c) => c.args[0])).toEqual(['hi', 'echo:yo'])
  expect(socketCount()).toBe(held)
})

test('a guard that returns 401 refuses the upgrade: no 101, no socket', async () => {
  const app = new Elysia({ adapter: brust() })
    .guard({ beforeHandle: ({ status }) => status(401, 'no') })
    .ws('/ws', { message() {} })
  const before = socketCount()
  const { out } = await connect(app)
  expect(out.status).toBe(401)
  expect(out.ws).toBeUndefined()
  expect(socketCount()).toBe(before)
})

test('ws.data carries derive values from the upgrade request', async () => {
  let seen: unknown
  const app = new Elysia({ adapter: brust() })
    .derive(({ request }) => ({ user: request.headers.get('x-user') }))
    .ws('/ws', { open(ws) { seen = (ws.data as { user?: unknown }).user ?? (ws as unknown as { user?: unknown }).user } })
  const { out } = await connect(app, '/api/ws', { 'x-user': 'ada' })
  await events!(out.ws!.id, 'open', null, 0, '')
  expect(seen).toBe('ada')
})

test('subscribe / unsubscribe / publish / close / terminate map to the napi calls', async () => {
  let ws0: any
  const app = new Elysia({ adapter: brust() }).ws('/ws', { open(ws) { ws0 = ws } })
  const { out } = await connect(app)
  const id = out.ws!.id
  await events!(id, 'open', null, 0, '')
  ws0.subscribe('room')
  expect(ws0.isSubscribed('room')).toBe(true)
  expect(ws0.subscriptions).toEqual(['room'])
  ws0.publish('room', 'x')
  // publish skips the publisher unless publishToSelf: except = (worker, local)
  expect(calls.find((c) => c.fn === 'publish')!.args).toEqual(['room', 'x', 2, id])
  ws0.unsubscribe('room')
  expect(ws0.isSubscribed('room')).toBe(false)
  ws0.close(1001, 'bye')
  expect(calls.at(-1)).toEqual({ fn: 'close', args: [1001, 'bye'] })
  ws0.terminate() // already closing: no second native call
  expect(calls.filter((c) => c.fn === 'terminate')).toHaveLength(0)
})

test('publishToSelf sends no except', async () => {
  let ws0: any
  const app = new Elysia({ adapter: brust() }).ws('/ws', { publishToSelf: true, open(ws) { ws0 = ws } })
  const { out } = await connect(app)
  expect(out.ws?.publishToSelf).toBe(true)
  await events!(out.ws!.id, 'open', null, 0, '')
  ws0.publish('room', 'x')
  expect(calls.find((c) => c.fn === 'publish')!.args).toEqual(['room', 'x'])
})

test('app.server.publish is a server-level wsPublish', async () => {
  const outer = mount(new Elysia({ adapter: brust() }).ws('/ws', { message() {} }))
  expect((outer as unknown as { server: { publish(t: string, d: string): number } }).server.publish('t', 'd')).toBe(3)
  expect(calls[0]).toEqual({ fn: 'publish', args: ['t', 'd'] })
})

test('readyState: 0 until open, 1 in handlers, 2 after close(), 3 in the close handler', async () => {
  const states: number[] = []
  const app = new Elysia({ adapter: brust() }).ws('/ws', {
    open(ws) { states.push(ws.readyState) },
    close(ws) { states.push(ws.readyState) },
  })
  const { out } = await connect(app)
  await events!(out.ws!.id, 'open', null, 0, '')
  await events!(out.ws!.id, 'close', null, 1006, '')
  expect(states).toEqual([1, 3])
})

test('send after close drops (0) without reaching the native module', async () => {
  let ws0: any
  const app = new Elysia({ adapter: brust() }).ws('/ws', { open(ws) { ws0 = ws } })
  const { out } = await connect(app)
  await events!(out.ws!.id, 'open', null, 0, '')
  ws0.close()
  expect(ws0.send('late')).toBe(0)
  expect(calls.some((c) => c.fn === 'send')).toBe(false)
})

test('send returns the napi back-pressure codes (-1 queued, 0 dropped) and drain reaches the handler', async () => {
  const codes: number[] = []
  let drained = 0
  const app = new Elysia({ adapter: brust() }).ws('/ws', {
    open(ws) { sendCode = -1; codes.push(ws.raw.send('a')); sendCode = 0; codes.push(ws.raw.send('b')) },
    drain() { drained++ },
  })
  const { out } = await connect(app)
  await events!(out.ws!.id, 'open', null, 0, '')
  await events!(out.ws!.id, 'drain', null, 0, '')
  expect(codes).toEqual([-1, 0])
  expect(drained).toBe(1)
})

test('per-route options reach the A2 meta', async () => {
  const app = new Elysia({ adapter: brust() }).ws('/ws', { maxPayloadLength: 2048, idleTimeout: 30, backpressureLimit: 4096, closeOnBackpressureLimit: true, sendPings: false, message() {} })
  const { out } = await connect(app)
  expect(out.ws).toMatchObject({ maxPayload: 2048, idleTimeout: 30, backpressureLimit: 4096, closeOnBackpressureLimit: true, sendPings: false })
})

test('a handler that returns a promise holds the event promise (the credit Rust waits on)', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let done = false
  const app = new Elysia({ adapter: brust() }).ws('/ws', { async message() { await gate; done = true } })
  const { out } = await connect(app)
  await events!(out.ws!.id, 'open', null, 0, '')
  const p = events!(out.ws!.id, 'message', 'm', 0, '') as Promise<void>
  let settled = false
  void p.then(() => (settled = true))
  await Bun.sleep(10)
  expect(settled).toBe(false)
  release()
  await p
  expect(done).toBe(true)
})

test('D11: events run in the async context of the upgrade request', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const als = new AsyncLocalStorage<string>()
  let seen: string | undefined
  const app = new Elysia({ adapter: brust() }).ws('/ws', { message() { seen = als.getStore() } })
  const outer = mount(app)
  startActionSockets(outer, 2)
  const out = await als.run('upgrade-ctx', () => fetchParts(outer, up('/api/ws')))
  await events!(out.ws!.id, 'open', null, 0, '')
  await events!(out.ws!.id, 'message', 'x', 0, '')
  expect(seen).toBe('upgrade-ctx')
})

test('binary frames: nodebuffer by default, uint8array / arraybuffer on request', async () => {
  const got: unknown[] = []
  const app = new Elysia({ adapter: brust() }).ws('/ws', {
    open(ws) { (ws.raw as { binaryType: string }).binaryType = 'uint8array' },
    message(_ws, m) { got.push(m) },
  })
  const { out } = await connect(app)
  await events!(out.ws!.id, 'open', null, 0, '')
  await events!(out.ws!.id, 'message', Buffer.from([1, 2]), 0, '')
  expect(got[0]).toBeInstanceOf(Uint8Array)
  expect(Buffer.isBuffer(got[0])).toBe(false)
})

test('remoteAddress comes from the native call', async () => {
  let addr = ''
  const app = new Elysia({ adapter: brust() }).ws('/ws', { open(ws) { addr = (ws.raw as { remoteAddress: string }).remoteAddress } })
  const { out } = await connect(app)
  await events!(out.ws!.id, 'open', null, 0, '')
  expect(addr).toBe('203.0.113.7:4455')
})

test('an app that returns undefined without accepting an upgrade answers 500', async () => {
  const outer = { fetch: () => undefined }
  const out = await fetchParts(outer, new Request('http://l/x'))
  expect(out.status).toBe(500)
  expect(new TextDecoder().decode(out.body)).toContain('accepted no WebSocket upgrade')
})

test('an event for an unknown socket is dropped; an unknown open terminates it', async () => {
  const { out } = await connect(new Elysia({ adapter: brust() }).ws('/ws', { message() {} }))
  await events!(999_999, 'message', 'x', 0, '')
  expect(calls).toEqual([])
  await events!(999_999, 'open', null, 0, '')
  expect(calls).toEqual([{ fn: 'terminate', args: [] }])
  void out
})

test('typed message bodies still validate (t.Object) through the shim', async () => {
  const got: unknown[] = []
  const app = new Elysia({ adapter: brust() }).ws('/ws', { body: t.Object({ n: t.Number() }), message(_ws, b) { got.push(b) } })
  const { out } = await connect(app)
  await events!(out.ws!.id, 'open', null, 0, '')
  await events!(out.ws!.id, 'message', JSON.stringify({ n: 1 }), 0, '')
  expect(got).toEqual([{ n: 1 }])
})

// D14: the Elysia RC internals the adapter leans on, pinned so a bump fails here and not in production.
test('D14 pin: .ws() without the capability fails loudly; the adapter supplies it; app.server is what the route reads', async () => {
  setWebSocketCapability(null)
  const bare = new Elysia({ adapter: brust() }).ws('/ws', { message() {} })
  expect(bare['~hasWS']).toBe(true)
  await expect(Promise.resolve().then(() => bare.fetch(up('/ws')))).rejects.toThrow(/WebSocket capability/)
  setWebSocketCapability(websocket)
  const withCap = mount(new Elysia({ adapter: brust() }).ws('/ws', { message() {} }))
  expect(withCap['~hasWS']).toBe(true)
  expect(typeof withCap['~resolvedCapability']('ws')?.provider.buildGlobalWSHandler).toBe('function')
  expect(typeof withCap['~resolvedCapability']('ws')?.provider.declaredOptions).toBe('function')
  const s = (withCap as unknown as { server: { upgrade: unknown } }).server
  expect(typeof s.upgrade).toBe('function')
})

test('brust() without the capability leaves an app with no .ws() untouched', async () => {
  setWebSocketCapability(null)
  const app = mount(new Elysia({ adapter: brust() }).get('/x', () => 'ok'))
  expect(app['~hasWS']).toBeFalsy()
  const res = await app.fetch(new Request('http://l/api/x'))
  expect(await res!.text()).toBe('ok')
})
