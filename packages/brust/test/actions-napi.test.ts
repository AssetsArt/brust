// M3-F end to end: the REAL Rust server (napi `startServer` with `actions` + `cors`) forwarding the prefix subtree to
// the REAL worker dispatch (`makeDispatch` → `runFetch`) and relaying the framed answer. The app is a hand-written
// `{ fetch }` (no Elysia). Server-starting file: runs alone (ci.yml).
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { beginDrain, localAddr, registerWorker, startServer, untilReady } from '../native/index.js'
import { setActionsApp, setActionsLimits } from '../src/actions-bridge'
import type { StoreRecord } from '../src/store/core-adapter'
import { getServerInstance } from '../src/store/server-context'
import { type Handlers, type JobCall, makeDispatch, SLOT_BYTES } from '../src/worker'

const dist = resolve(import.meta.dir, '../../../crates/brust-server/tests/fixtures/dist')
const PREFIX_TAG = '<script>globalThis.__BRUST_ACTION_PREFIX__="/api"</script>'

// The FakeBun default jobs (as napi-server.test.ts).
function jobValue(call: JobCall) {
  const job = call.id.split('/').at(call.id.startsWith(`${call.componentId}/`) ? 1 : 2)
  if (call.componentId === 'detailPage_c3' && job === 'j0') return { _s1: 'HP 35' }
  if (call.componentId === 'moveCard_d4' && job === 'j0') return { _s1: `MOVE ${call.inputs.move.name}` }
  if ((call.target ?? call.componentId) === 'teamBuilder_h8') return '<ul><li>a</li></ul>'
  throw new Error(`unexpected job ${call.id}`)
}
const h: Handlers = {
  async loader(req) {
    const name = (req.params as Record<string, string>).name ?? null
    return { ok: true, data: { pokemon: { name, stats: { hp: 35 }, moves: [{ name: 'tackle' }, { name: 'growl' }] }, team: ['a'], who: 'anon' } }
  },
  async jobs(req) {
    return { results: (req.jobs ?? []).map((j) => ({ id: j.id, value: jobValue(j) })) }
  },
}

const seen: string[] = []
const app = {
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url)
    seen.push(`${req.method} ${pathname}`)
    if (pathname === '/api/team') return Response.json({ echo: await req.json() }, { status: 201 })
    if (pathname === '/api/bin') {
      const headers = new Headers({ 'content-type': 'application/octet-stream' })
      headers.append('set-cookie', 'a=1; Path=/')
      headers.append('set-cookie', 'b=2; Path=/; HttpOnly')
      return new Response(await req.arrayBuffer(), { headers })
    }
    if (pathname === '/api/big') return new Response(new Uint8Array(300 * 1024))
    if (pathname === '/api/len') {
      const b = new Uint8Array(await req.arrayBuffer())
      return Response.json({ len: b.length, hash: String(Bun.hash(b)) })
    }
    if (pathname === '/api/huge') return new Response(new Uint8Array((2 << 20) + 1))
    if (pathname === '/api/store') return Response.json(getServerInstance('m3f-e2e', (): StoreRecord => ({ instance: { n: 7 } })).instance)
    return new Response('nope', { status: 404 })
  },
}

test('actions through the real Rust server and worker dispatch', async () => {
  // Boot errors, before any server: each message is asserted (a bare toThrow() is a green lie).
  const base0 = { host: '127.0.0.1', port: 0, distDir: dist, workers: 1, claimTimeoutMs: 500 }
  // The process-wide server as it is now: none when this file runs alone, an earlier file's in a full `bun test`.
  const current = () => {
    try {
      return localAddr()
    } catch (e) {
      return (e as Error).message
    }
  }
  const server0 = current()
  expect(() => startServer({ ...base0, cors: { origins: ['*'], credentials: true } })).toThrow(/cors: .*wildcard/)
  expect(() => startServer({ ...base0, actions: { prefix: '/_brust' } })).toThrow(/actions: .*reserved/)
  expect(current()).toBe(server0) // a failed boot starts and replaces nothing

  startServer({
    ...base0,
    actions: { prefix: '/api', maxBodyBytes: 1024 },
    cors: { origins: ['http://allowed.test'], credentials: true },
  })
  setActionsApp(app)
  const view = new Uint8Array(new SharedArrayBuffer(SLOT_BYTES * 2))
  expect(registerWorker(view, 2, makeDispatch(h, view, 2))).toBeGreaterThanOrEqual(0)
  await untilReady(2000)
  const base = `http://${localAddr()}`
  const origin = { origin: 'http://allowed.test' }

  // POST JSON round trip, CORS stamped at the chokepoint.
  const team = await fetch(`${base}/api/team?x=1`, { method: 'POST', headers: { ...origin, 'content-type': 'application/json' }, body: '{"name":"pikachu"}' })
  expect(team.status).toBe(201)
  expect(await team.json()).toEqual({ echo: { name: 'pikachu' } })
  expect(team.headers.get('access-control-allow-origin')).toBe('http://allowed.test')
  expect(team.headers.get('access-control-allow-credentials')).toBe('true')
  expect(team.headers.get('x-brust-cache')).toBeNull()

  // binary body and two cookies through Rust.
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
  const bin = await fetch(`${base}/api/bin`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes })
  expect(bin.status).toBe(200)
  expect(new Uint8Array(await bin.arrayBuffer())).toEqual(bytes)
  expect(bin.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly'])

  // Over the body cap: 413 from Rust, the app is never called.
  const before = seen.length
  const big = await fetch(`${base}/api/team`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1025) })
  expect(big.status).toBe(413)
  expect(await big.text()).toBe('payload too large')
  expect(seen.length).toBe(before)

  // CORS preflight under the prefix: answered by Rust (204), never reaches the app.
  const pre = await fetch(`${base}/api/team`, {
    method: 'OPTIONS',
    headers: { ...origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  })
  expect(pre.status).toBe(204)
  expect(pre.headers.get('access-control-allow-origin')).toBe('http://allowed.test')
  expect(pre.headers.get('access-control-allow-credentials')).toBe('true')
  expect(pre.headers.get('access-control-allow-methods')).toContain('POST')
  expect(seen.length).toBe(before)

  // A page outside the prefix: unaffected, carries the A4 prefix script once, CORS-stamped.
  const page = await fetch(`${base}/pokemon/pikachu`, { headers: origin })
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('<p>HP 35</p>')
  expect(html.split(PREFIX_TAG).length - 1).toBe(1)
  expect(page.headers.get('access-control-allow-origin')).toBe('http://allowed.test')

  // The default prefix is NOT an action subtree when another prefix is configured.
  const def = await fetch(`${base}/_brust/action/x`, { method: 'POST', body: '{}' })
  expect(def.status).toBe(405)
  await def.text()

  // A 300 KiB answer no longer fits the slot: it crosses by heap transfer (F82) in full.
  const big300 = await fetch(`${base}/api/big`)
  expect(big300.status).toBe(200)
  expect((await big300.arrayBuffer()).byteLength).toBe(300 * 1024)

  // The fetch runs in a store scope.
  const store = await fetch(`${base}/api/store`)
  expect(store.status).toBe(200)
  expect(await store.json()).toEqual({ n: 7 })

  expect(seen).toEqual(['POST /api/team', 'POST /api/bin', 'GET /api/big', 'GET /api/store'])
  await beginDrain(2000)
  setActionsApp(null)
})

const patterned = (n: number, mul = 1) => Uint8Array.from({ length: n }, (_, i) => (i * mul) % 251)
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

// F82: bodies over the slot cross by heap transfer, both directions, through the real addon.
test('large action bodies cross by heap transfer, both directions (F82)', async () => {
  seen.length = 0
  startServer({
    host: '127.0.0.1',
    port: 0,
    distDir: dist,
    workers: 1,
    claimTimeoutMs: 500,
    actions: { prefix: '/api', maxBodyBytes: 4 << 20, maxResponseBytes: 2 << 20 },
  })
  setActionsApp(app)
  setActionsLimits({ maxResponseBytes: 2 << 20 })
  const view = new Uint8Array(new SharedArrayBuffer(SLOT_BYTES * 2))
  expect(registerWorker(view, 2, makeDispatch(h, view, 2))).toBeGreaterThanOrEqual(0)
  await untilReady(2000)
  const base = `http://${localAddr()}`
  const octet = { 'content-type': 'application/octet-stream' }

  // 300 KiB binary echo, byte-equal.
  const bin300 = patterned(300 * 1024)
  const r1 = await fetch(`${base}/api/bin`, { method: 'POST', headers: octet, body: bin300 })
  expect(r1.status).toBe(200)
  expect(same(new Uint8Array(await r1.arrayBuffer()), bin300)).toBe(true)

  // 1.5 MiB JSON: heap in and heap out (an echo of 3 MiB would exceed the 2 MiB response cap).
  const text = 'y'.repeat(1536 << 10)
  const r2 = await fetch(`${base}/api/team`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  expect(r2.status).toBe(201)
  expect(((await r2.json()) as { echo: { text: string } }).echo.text === text).toBe(true)

  // 3 MiB JSON in (heap request body, over the response cap): the app sees all of it.
  const json3 = JSON.stringify({ text: 'z'.repeat(3 << 20) })
  const r3 = await fetch(`${base}/api/len`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json3 })
  expect(r3.status).toBe(200)
  expect(await r3.json()).toEqual({ len: json3.length, hash: String(Bun.hash(new TextEncoder().encode(json3))) })

  // Over max_response_bytes: 500 with the cap in the text.
  const huge = await fetch(`${base}/api/huge`)
  expect(huge.status).toBe(500)
  expect(await huge.text()).toBe('brust: action response exceeds 2097152 bytes')

  // Over max_body_bytes: 413 before the worker.
  const before = seen.length
  const over = await fetch(`${base}/api/bin`, { method: 'POST', headers: octet, body: new Uint8Array((4 << 20) + 1) })
  expect(over.status).toBe(413)
  await over.text()
  expect(seen.length).toBe(before)

  // 8 concurrent 1 MiB echoes: each slot's cell is its own.
  const bodies = Array.from({ length: 8 }, (_, k) => patterned(1 << 20, k + 1))
  const rs = await Promise.all(bodies.map((b) => fetch(`${base}/api/bin`, { method: 'POST', headers: octet, body: b })))
  for (const [k, r] of rs.entries()) {
    expect(r.status).toBe(200)
    expect(same(new Uint8Array(await r.arrayBuffer()), bodies[k] as Uint8Array)).toBe(true)
  }

  await beginDrain(2000)
  setActionsApp(null)
  setActionsLimits({ maxResponseBytes: 8_388_608 })
})
