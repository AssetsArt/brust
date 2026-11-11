// F529 D12: `brust dev`'s proxy relays WebSocket upgrades under the actions prefix to the child (browser <-> proxy <-> child).
// The child here is a plain Bun.serve with a websocket handler, so no addon and no build are involved.
import { afterEach, expect, test } from 'bun:test'
import { type DevProxy, isWsUpgrade, refusedStatus, relayCloseCode, startProxy } from '../src/dev/proxy'

const TOKEN = 'dev-token-1'
const BASE = '/app'
const PREFIX = `${BASE}/_brust/action`

interface Seen {
  host: string | null
  origin: string | null
  cookie: string | null
  token: string | null
  path: string
}

const stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops.splice(0).reverse()) s()
})

/** A child that echoes, refuses `.../deny` with a 401 (a guard), records what the handshake carried and every close it sees. */
function startChild() {
  const seen: Seen[] = []
  const closes: { code: number; reason: string }[] = []
  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      seen.push({ host: req.headers.get('host'), origin: req.headers.get('origin'), cookie: req.headers.get('cookie'), token: req.headers.get('x-brust-dev-token'), path: url.pathname + url.search })
      if (url.pathname.endsWith('/deny')) return new Response('unauthorized', { status: 401 })
      if (srv.upgrade(req, { data: undefined })) return undefined
      return new Response('plain', { status: 200 })
    },
    websocket: {
      message(ws, m) {
        if (m === 'close-me') ws.close(4001, 'app says bye')
        else ws.send(m)
      },
      close(_ws, code, reason) {
        closes.push({ code, reason })
      },
    },
  })
  stops.push(() => void server.stop(true))
  return { server, port: server.port as number, seen, closes }
}

function startDev(upstream: () => number | null, token = TOKEN): DevProxy {
  const proxy = startProxy(
    { hostname: '127.0.0.1', port: 0, token, basePath: BASE },
    {
      gen: () => 1,
      state: () => 'ready',
      diag: () => null,
      upstream,
      onRequest: () => {},
      meta: () => null,
      actionsPrefix: () => PREFIX,
    },
  )
  stops.push(() => proxy.stop())
  return proxy
}

const wsUrl = (p: DevProxy, path: string) => `ws://127.0.0.1:${p.port}${path}`

/** Open `url` with request headers; resolves the socket, or the failure text ("Expected 101 status code: 403"). */
function connect(url: string, headers: Record<string, string> = {}): Promise<WebSocket | string> {
  return new Promise((resolve) => {
    // biome-ignore lint/suspicious/noExplicitAny: Bun's WebSocket takes request headers
    const ws = new WebSocket(url, { headers } as any)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => resolve((e as ErrorEvent).message)
  })
}
const next = (ws: WebSocket) => new Promise<string | ArrayBuffer>((r) => (ws.onmessage = (e) => r(e.data)))
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => (ws.onclose = (e) => r({ code: e.code, reason: e.reason })))
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(20)
}

test('relays text and binary under the base path + actions prefix, with cookies, Origin and Host as the browser sent them', async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const host = `localhost:${dev.port}`
  const ws = await connect(wsUrl(dev, `${PREFIX}/chat?room=7`), { host, origin: `http://${host}`, cookie: 'sid=abc', 'x-brust-dev-token': 'forged' })
  expect(typeof ws).not.toBe('string')
  const sock = ws as WebSocket
  const t = next(sock)
  sock.send('hello')
  expect(await t).toBe('hello')
  const b = next(sock)
  sock.send(new Uint8Array([1, 2, 3, 250]))
  expect([...new Uint8Array((await b) as ArrayBuffer)]).toEqual([1, 2, 3, 250])
  expect(child.seen).toEqual([{ host, origin: `http://${host}`, cookie: 'sid=abc', token: TOKEN, path: `${PREFIX}/chat?room=7` }])
  sock.close()
})

test('a browser close reaches the child with its code and reason', async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const ws = (await connect(wsUrl(dev, `${PREFIX}/chat`))) as WebSocket
  const c = closed(ws)
  ws.close(3001, 'bye')
  await c
  await until(() => child.closes.length > 0)
  expect(child.closes).toEqual([{ code: 3001, reason: 'bye' }])
})

test('a child close with an app code is forwarded to the browser as is', async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const ws = (await connect(wsUrl(dev, `${PREFIX}/chat`))) as WebSocket
  const c = closed(ws)
  ws.send('close-me')
  expect(await c).toEqual({ code: 4001, reason: 'app says bye' })
})

test('a cross-origin upgrade is refused 403 and never reaches the child', async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const r = await connect(wsUrl(dev, `${PREFIX}/chat`), { origin: 'https://evil.example' })
  expect(r).toBe(`WebSocket connection to '${wsUrl(dev, `${PREFIX}/chat`)}' failed: Expected 101 status code: 403`)
  expect(child.seen).toEqual([])
})

test('an unknown Host is answered 421 before anything else', async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const r = await connect(wsUrl(dev, `${PREFIX}/chat`), { host: 'evil.example' })
  expect(String(r)).toContain('Expected 101 status code: 421')
  expect(child.seen).toEqual([])
})

test("the child's refusal (a guard's 401) reaches the browser as its HTTP status", async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const r = await connect(wsUrl(dev, `${PREFIX}/deny`))
  expect(String(r)).toContain('Expected 101 status code: 401')
  expect(child.seen.length).toBe(1)
})

test('no child yet answers 503; an unreachable child 502', async () => {
  const none = startDev(() => null)
  expect(String(await connect(wsUrl(none, `${PREFIX}/chat`)))).toContain('Expected 101 status code: 503')
  const dead = startChild()
  const port = dead.port
  dead.server.stop(true)
  const dev = startDev(() => port)
  expect(String(await connect(wsUrl(dev, `${PREFIX}/chat`)))).toContain('Expected 101 status code: 502')
})

test('a child restart closes the browser socket with 1012 "service restart"', async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const ws = (await connect(wsUrl(dev, `${PREFIX}/chat`))) as WebSocket
  const c = closed(ws)
  await Bun.sleep(20)
  child.server.stop(true)
  expect(await c).toEqual({ code: 1012, reason: 'service restart' })
})

test('stopping the proxy closes the child leg of a relayed socket too', async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const ws = (await connect(wsUrl(dev, `${PREFIX}/chat`))) as WebSocket
  const c = closed(ws)
  dev.stop()
  await c
  await until(() => child.closes.length > 0)
  expect(child.closes.length).toBe(1)
})

test('an upgrade outside the actions prefix is not relayed, and the dev channel socket still works', async () => {
  const child = startChild()
  const dev = startDev(() => child.port)
  const r = await connect(wsUrl(dev, `${BASE}/other`))
  expect(String(r)).toContain('Expected 101 status code: 426')
  expect(child.seen).toEqual([])
  const dws = await connect(wsUrl(dev, `${BASE}/_brust/dev/ws`))
  expect(typeof dws).not.toBe('string')
  ;(dws as WebSocket).close()
})

test('isWsUpgrade: a GET listing the websocket token; relayCloseCode and refusedStatus helpers', () => {
  const req = (method: string, upgrade?: string) => new Request('http://x/', { method, headers: upgrade ? { upgrade } : {} })
  expect(isWsUpgrade(req('GET', 'websocket'))).toBe(true)
  expect(isWsUpgrade(req('GET', 'h2c, WebSocket'))).toBe(true)
  expect(isWsUpgrade(req('GET', 'h2c'))).toBe(false)
  expect(isWsUpgrade(req('GET'))).toBe(false)
  expect(isWsUpgrade(req('POST', 'websocket'))).toBe(false)
  expect([1001, 1006, 1012].map((c) => relayCloseCode(c, true))).toEqual([1012, 1012, 1012])
  expect([1000, 1008, 1009, 3000, 4999].map((c) => relayCloseCode(c, true))).toEqual([1000, 1008, 1009, 3000, 4999])
  expect(relayCloseCode(1005, true)).toBe(1000)
  expect(relayCloseCode(1015, true)).toBe(1011)
  expect(relayCloseCode(1001, false)).toBe(1001)
  expect(relayCloseCode(1006, false)).toBe(1000)
  expect(relayCloseCode(5000, false)).toBe(1000)
  expect(refusedStatus("WebSocket connection to 'ws://x/' failed: Expected 101 status code: 401")).toBe(401)
  expect(refusedStatus('Expected 101 status code: 200')).toBe(502)
  expect(refusedStatus('connect ECONNREFUSED')).toBe(502)
})
