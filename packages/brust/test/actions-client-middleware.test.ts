// F471: `client({ middleware })`. The chain sits between Eden and the transport; docs/actions.md "Middleware".
import { describe, expect, test } from 'bun:test'
import { Elysia, status, t } from 'elysia'
import { brust } from '../src/actions/elysia'
import { type ActionMiddleware, client } from '../src/actions/client'
import { mountActions } from '../src/actions/load'
import fixtureApp, { type App } from './fixtures/actions/app'

const BASE = 'http://l.test'
type Seen = { url: string; method: string; headers: Headers; body: string }

/** Transport: records every request that actually goes out (body read), answers from the real app mounted at the default prefix. */
function transport(seen: Seen[], app: Elysia<any, any, any, any, any, any, any> = fixtureApp as never) {
  const mounted = mountActions(app as never, '/_brust/action')
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: await req.clone().text() })
    return mounted.fetch(req)
  }) as unknown as typeof fetch
}

const mk = (middleware: ActionMiddleware[], seen: Seen[] = [], extra: Record<string, unknown> = {}) =>
  client<App>({ baseUrl: BASE, fetch: transport(seen), middleware, ...extra })

describe('client middleware (F471)', () => {
  test('onion order: middleware[0] is the outermost', async () => {
    const log: string[] = []
    const tag = (n: string): ActionMiddleware => async (req, next) => {
      log.push(`${n}>`)
      const res = await next(req)
      log.push(`<${n}`)
      return res
    }
    const r = await mk([tag('a'), tag('b'), tag('c')]).hello.get()
    expect(r.status).toBe(200)
    expect(log).toEqual(['a>', 'b>', 'c>', '<c', '<b', '<a'])
  })

  test('header injection reaches the transport; Eden headers and onRequest are already applied', async () => {
    const seen: Seen[] = []
    const mw: ActionMiddleware = (req, next) => {
      expect(req.headers.get('x-eden')).toBe('1')
      expect(req.headers.get('x-on-request')).toBe('1')
      const r = new Request(req)
      r.headers.set('x-org', 'o1')
      return next(r)
    }
    const api = mk([mw], seen, {
      headers: { 'x-eden': '1' },
      onRequest: () => ({ headers: { 'x-on-request': '1' } }),
    })
    const r = await api.hello.get()
    expect(r.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers.get('x-org')).toBe('o1')
    expect(seen[0]!.headers.get('x-eden')).toBe('1')
    expect(seen[0]!.headers.get('x-on-request')).toBe('1')
  })

  test('a GET and a query string arrive as built', async () => {
    const seen: Seen[] = []
    const r = await mk([(req, next) => next(req)], seen).hello.get({ query: { name: 'a b' } })
    expect(r.data).toEqual({ hi: 'a b' })
    expect(seen[0]!.url).toBe(`${BASE}/_brust/action/hello?name=a%20b`)
    expect(seen[0]!.method).toBe('GET')
  })

  test('retry after 401: the same JSON body is sent again', async () => {
    const seen: Seen[] = []
    let renewed = 0
    const app = new Elysia({ adapter: brust() }).post('/team', { body: t.Object({ id: t.String() }) }, ({ request }) => {
      const ok = request.headers.get('x-token') === 'fresh'
      return ok ? status(200, { ok: true as const }) : status(401, { error: 'unauthorized' as const })
    })
    const renew: ActionMiddleware = async (req, next) => {
      const res = await next(req)
      if (res.status !== 401) return res
      renewed++
      const r = new Request(req)
      r.headers.set('x-token', 'fresh')
      return next(r)
    }
    const api = client<typeof app>({ baseUrl: BASE, fetch: transport(seen, app as never), middleware: [renew] })
    const r = await api.team.post({ id: 'x' })
    expect(r.status).toBe(200)
    expect(renewed).toBe(1)
    expect(seen.map((s) => s.body)).toEqual(['{"id":"x"}', '{"id":"x"}'])
    expect(seen[0]!.headers.get('x-token')).toBeNull()
    expect(seen[1]!.headers.get('x-token')).toBe('fresh')
  })

  test('retry with the SAME req value and a middleware that builds a new Request from it still sends the body twice', async () => {
    // [renew, org]: org does `new Request(req)` (consumes its own copy); renew re-sends its own, unread req
    const seen: Seen[] = []
    const app = new Elysia({ adapter: brust() }).post('/p', { body: t.Object({ v: t.Number() }) }, ({ request }) =>
      request.headers.get('x-t') === '2' ? status(200, { ok: true as const }) : status(401, { error: 'no' as const }),
    )
    let n = 0
    const renew: ActionMiddleware = async (req, next) => {
      const res = await next(req)
      if (res.status !== 401) return res
      n++
      return next(req)
    }
    const org: ActionMiddleware = (req, next) => {
      const r = new Request(req)
      r.headers.set('x-t', String(seen.length + 1))
      return next(r)
    }
    const api = client<typeof app>({ baseUrl: BASE, fetch: transport(seen, app as never), middleware: [renew, org] })
    const r = await api.p.post({ v: 7 })
    expect(r.status).toBe(200)
    expect(n).toBe(1)
    expect(seen.map((s) => s.body)).toEqual(['{"v":7}', '{"v":7}'])
  })

  test('retry with multipart: the second request carries the same file', async () => {
    const seen: Seen[] = []
    const app = new Elysia({ adapter: brust() }).post('/up', async ({ request }) => {
      const f = (await request.formData()).get('file') as File
      return request.headers.get('x-t') ? { name: f.name, text: await f.text() } : status(401, { error: 'no' as const })
    })
    const mw: ActionMiddleware = async (req, next) => {
      const res = await next(req)
      if (res.status !== 401) return res
      const r = new Request(req)
      r.headers.set('x-t', '1')
      return next(r)
    }
    const api = client<typeof app>({ baseUrl: BASE, fetch: transport(seen, app as never), middleware: [mw] })
    const r = await (api as any).up.post({ file: new File(['hello'], 'a.txt', { type: 'text/plain' }) })
    expect(r.status).toBe(200)
    expect(r.data).toEqual({ name: 'a.txt', text: 'hello' })
    expect(seen).toHaveLength(2)
    expect(seen[0]!.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    expect(seen[1]!.body).toBe(seen[0]!.body)
    expect(seen[0]!.body).toContain('hello')
  })

  test('short-circuit: a link may answer without calling next; the transport is never reached', async () => {
    const seen: Seen[] = []
    const mw: ActionMiddleware = () => Response.json({ hi: 'cached' })
    const r = await mk([mw], seen).hello.get()
    expect(r.data).toEqual({ hi: 'cached' })
    expect(seen).toHaveLength(0)
  })

  test('a throwing middleware is a network failure: status 503, error.value is the thrown error', async () => {
    const boom = new Error('no session')
    const r = await mk([() => { throw boom }]).hello.get()
    expect(r.status).toBe(503)
    expect(r.error?.value as unknown).toBe(boom)
    const r2 = await mk([async () => { throw boom }]).hello.get()
    expect(r2.status).toBe(503)
  })

  test('a relative URL with no page origin fails like a network error (use baseUrl on the server)', async () => {
    const api = client<App>({ fetch: transport([]), middleware: [(req, next) => next(req)] })
    const r = await api.hello.get()
    expect(r.status).toBe(503)
  })

  test('throwHttpError still throws on a non-2xx the chain returns', async () => {
    const api = mk([(req, next) => next(req)], [], { throwHttpError: true })
    let err: unknown
    try {
      await api.team.post({ id: 'full', name: 'a' })
    } catch (e) {
      err = e
    }
    expect((err as { status?: number }).status).toBe(409)
  })

  test('typed results survive the chain: returned problem() narrows, validation is 422', async () => {
    const api = mk([(req, next) => next(req)])
    const r = await api.team.post({ id: 'full', name: 'a' })
    expect(r.error?.status).toBe(409)
    if (r.error?.status === 409) expect(r.error.value.max).toBe(6)
    const bad = await api.team.post({ id: 1, name: 'a' } as never)
    expect(bad.error?.status).toBe(422)
  })

  test('an empty list is the plain transport (Request is never built: relative URL passes through)', async () => {
    const calls: string[] = []
    const f = (async (u: unknown) => {
      calls.push(String(u))
      return Response.json({ hi: 'x' })
    }) as unknown as typeof fetch
    const r = await client<App>({ fetch: f, middleware: [] }).hello.get()
    expect(r.status).toBe(200)
    expect(calls).toEqual(['/_brust/action/hello'])
  })
})

describe('client middleware: the navigation cache', () => {
  test('a GET does not clear it; a POST clears it once per request that went out (a retry clears twice)', async () => {
    const KEY = Symbol.for('brust.nav')
    let cleared = 0
    ;(globalThis as Record<symbol, unknown>)[KEY] = { clearCache: () => cleared++ }
    try {
      const app = new Elysia({ adapter: brust() })
        .get('/g', () => ({ ok: true }))
        .post('/p', ({ request }) => (request.headers.get('x-t') ? status(200, { ok: true as const }) : status(401, { e: 'u' as const })))
      const retry: ActionMiddleware = async (req, next) => {
        const res = await next(req)
        if (res.status !== 401) return res
        const r = new Request(req)
        r.headers.set('x-t', '1')
        return next(r)
      }
      const api = client<typeof app>({ baseUrl: BASE, fetch: transport([], app as never), middleware: [retry] })
      await api.g.get()
      expect(cleared).toBe(0)
      const r = await api.p.post()
      expect(r.status).toBe(200)
      expect(cleared).toBe(2)
      const sc = client<typeof app>({ baseUrl: BASE, fetch: transport([], app as never), middleware: [() => new Response('{}', { headers: { 'content-type': 'application/json' } })] })
      await sc.p.post()
      expect(cleared).toBe(2) // answered without a request going out: nothing changed on the server
    } finally {
      delete (globalThis as Record<symbol, unknown>)[KEY]
    }
  })
})

describe('client middleware: types are kept', () => {
  test('route types still check after `middleware` is given (checked by `bun check`)', async () => {
    const api = client<App>({ baseUrl: BASE, fetch: transport([]), middleware: [(req, next) => next(req)] })
    const never = async () => {
      // @ts-expect-error name is required by the body schema
      void api.team.post({ id: '1' })
      // @ts-expect-error unknown route
      void api.nope
      // @ts-expect-error id must be a string
      void api.team.post({ id: 1, name: 'a' })
      const r = await api.team.post({ id: 'full', name: 'a' })
      if (r.error?.status === 409) {
        const max: number = r.error.value.max
        void max
        // @ts-expect-error the 409 body has no such field
        void r.error.value.nope
      }
      const ok: number | undefined = r.data?.max
      void ok
    }
    expect(typeof never).toBe('function')
    const r = await api.team.post({ id: '1', name: 'a' })
    expect(r.data?.max).toBe(6)
  })
})
