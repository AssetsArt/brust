// F542: `brust dev`'s proxy injects the dev client only into pages the core rendered (they carry the `x-brust-dev` trace).
// HTML an action or an Elysia route returned is the app's own and passes through untouched. The child is a plain Bun.serve.
import { afterEach, expect, test } from 'bun:test'
import { type DevProxy, startProxy } from '../src/dev/proxy'

const TOKEN = 'dev-token-1'
const trace = Buffer.from(JSON.stringify({ status: 200, cache: 'MISS', route: null, jobs: [], rendered: [] })).toString('base64')
const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`

const stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops.splice(0).reverse()) s()
})

function start(): DevProxy {
  const child = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname
      const h = { 'content-type': 'text/html; charset=utf-8' }
      if (p === '/page') return new Response(html('page'), { headers: { ...h, 'x-brust-dev': trace } })
      if (p === '/missing') return new Response(html('not found'), { status: 404, headers: { ...h, 'x-brust-dev': trace } })
      if (p === '/api/doc') return new Response(html('app'), { headers: h }) // an Elysia route's raw Response: no trace
      return new Response('x', { status: 404 })
    },
  })
  stops.push(() => void child.stop(true))
  const proxy = startProxy(
    { hostname: '127.0.0.1', port: 0, token: TOKEN },
    { gen: () => 1, state: () => 'ready', diag: () => null, upstream: () => child.port as number, onRequest: () => {}, meta: () => null, actionsPrefix: () => '/api' },
  )
  stops.push(() => proxy.stop())
  return proxy
}

const get = (p: DevProxy, path: string) => fetch(`http://127.0.0.1:${p.port}${path}`, { headers: { 'sec-fetch-dest': 'document', accept: 'text/html' } })

test('a page the core rendered gets the dev client and its trace', async () => {
  const body = await (await get(start(), '/page')).text()
  expect(body).toContain('/_brust/dev/client.js')
  expect(body).toContain('id="__brust_trace"')
})

test('a 404 page the core rendered still gets them', async () => {
  const r = await get(start(), '/missing')
  expect(r.status).toBe(404)
  expect(await r.text()).toContain('/_brust/dev/client.js')
})

test('HTML from an action / Elysia route (no trace) passes through untouched', async () => {
  const r = await get(start(), '/api/doc')
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toContain('text/html')
  expect(await r.text()).toBe(html('app'))
})

test('a proxy-made page (502 when the child is gone) keeps its own injection', async () => {
  const proxy = startProxy(
    { hostname: '127.0.0.1', port: 0, token: TOKEN },
    { gen: () => 1, state: () => 'ready', diag: () => null, upstream: () => 1, onRequest: () => {}, meta: () => null, actionsPrefix: () => '/api' },
  )
  stops.push(() => proxy.stop())
  const r = await get(proxy, '/page')
  expect(r.status).toBe(502)
  expect(await r.text()).toContain('/_brust/dev/client.js')
})
