// F471: an action that sets TWO cookies and answers a typed `status(401, ...)` must deliver both Set-Cookie headers
// through brust's Elysia adapter and the bridge's framing, and the client must still see the typed error.
import { describe, expect, test } from 'bun:test'
import { Elysia, status, t } from 'elysia'
import { brust } from '../src/actions/elysia'
import { client } from '../src/actions/client'
import { fetchInScope } from '../src/actions-bridge'
import { mountActions } from '../src/actions/load'

const app = new Elysia({ adapter: brust() })
  .post('/logout', ({ cookie }) => {
    cookie.sid!.set({ value: '', maxAge: 0, path: '/', httpOnly: true })
    cookie.csrf!.set({ value: '', maxAge: 0, path: '/' })
    return status(401, { error: 'unauthorized' as const })
  })
  .post('/headers', ({ set }) => {
    set.headers['set-cookie'] = ['sid=; Max-Age=0; Path=/', 'csrf=; Max-Age=0; Path=/']
    return status(401, { error: 'unauthorized' as const })
  })
  .post('/login', { body: t.Object({ user: t.String() }), cookie: t.Cookie({ sid: t.Optional(t.String()), csrf: t.Optional(t.String()) }) }, ({ body, cookie }) => {
    cookie.sid!.value = `s-${body.user}`
    cookie.csrf!.value = `c-${body.user}`
    return { user: body.user }
  })
type A = typeof app

const post = (path: string, body?: unknown) =>
  new Request(`http://l.test/_brust/action${path}`, {
    method: 'POST',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })

describe('two cookies on a typed answer', () => {
  const mounted = mountActions(app as never, '/_brust/action')

  test.each(['/logout', '/headers'])('%s: both Set-Cookie headers reach the response', async (path) => {
    const res = await fetchInScope(mounted as never, post(path))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0])
    expect(cookies.sort()).toEqual(['csrf=', 'sid='])
  })

  test('a typed 200 with two cookies set from the cookie schema', async () => {
    const res = await fetchInScope(mounted as never, post('/login', { user: 'a' }))
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().map((c) => c.split(';')[0]).sort()).toEqual(['csrf=c-a', 'sid=s-a'])
  })

  test.each(['/logout', '/headers'] as const)('%s: the client sees the typed error.value and both cookies pass the chain', async (path) => {
    const seen: string[][] = []
    const api = client<A>({
      baseUrl: 'http://l.test',
      fetch: ((u: RequestInfo | URL, i?: RequestInit) => mounted.fetch(new Request(u, i))) as typeof fetch,
      middleware: [
        async (req, next) => {
          const res = await next(req)
          seen.push(res.headers.getSetCookie().map((c) => c.split(';')[0]!))
          return res
        },
      ],
    })
    const r = await (path === '/logout' ? api.logout.post() : api.headers.post())
    expect(r.status).toBe(401)
    expect(r.data).toBeNull()
    if (r.error?.status === 401) {
      const e: 'unauthorized' = r.error.value.error
      expect(e).toBe('unauthorized')
    } else throw new Error('expected a typed 401')
    expect(seen[0]?.sort()).toEqual(['csrf=', 'sid='])
  })
})
