import { afterEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { brust } from '../src/actions/elysia'
import { client } from '../src/actions/client'
import { mountActions } from '../src/actions/load'
import fixtureApp, { type App } from './fixtures/actions/app'

type Call = { url: string; init: RequestInit | undefined }

/** Stub transport: records the call, then answers from the real app mounted under `prefix`. */
function stub(calls: Call[], prefix = '/_brust/action', app: Elysia<any, any, any, any, any, any, any> = fixtureApp as never) {
  const mounted = mountActions(app as never, prefix)
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const u = new URL(url, 'http://l')
    return mounted.fetch(new Request(`http://l${u.pathname}${u.search}`, init))
  }) as unknown as typeof fetch
}

afterEach(() => {
  delete (globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__
})

describe('client prefix + base', () => {
  test('prefix order 1: opts.prefix wins', async () => {
    ;(globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__ = '/g'
    const calls: Call[] = []
    const api = client<App>({ prefix: '/api', fetch: stub(calls, '/api') })
    const r = await api.hello.get()
    expect(calls[0]?.url).toBe('/api/hello')
    expect(r.status).toBe(200)
  })

  test('prefix order 2: baseUrl without prefix uses /_brust/action and never the global', async () => {
    ;(globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__ = '/g'
    const calls: Call[] = []
    const api = client<App>({ baseUrl: 'https://api.example.com', fetch: stub(calls) })
    await api.hello.get()
    expect(calls[0]?.url).toBe('https://api.example.com/_brust/action/hello')
  })

  test('prefix order 3: no baseUrl, no prefix → globalThis.__BRUST_ACTION_PREFIX__', async () => {
    ;(globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__ = '/custom-actions'
    const calls: Call[] = []
    const api = client<App>({ fetch: stub(calls, '/custom-actions') })
    await api.hello.get()
    expect(calls[0]?.url).toBe('/custom-actions/hello')
  })

  test('prefix order 4: nothing set → /_brust/action/hello (relative, keepDomain — never https:///…)', async () => {
    const calls: Call[] = []
    const api = client<App>({ fetch: stub(calls) })
    await api.hello.get()
    expect(calls[0]?.url).toBe('/_brust/action/hello')
  })

  test('baseUrl + custom prefix composes', async () => {
    const calls: Call[] = []
    const api = client<App>({ baseUrl: 'https://api.example.com', prefix: '/api', fetch: stub(calls, '/api') })
    await api.hello.get()
    expect(calls[0]?.url).toBe('https://api.example.com/api/hello')
  })

  test('baseUrl trailing slash is stripped; a path suffix composes', async () => {
    const calls: Call[] = []
    const api = client<App>({ baseUrl: 'https://api.example.com/v2/', fetch: stub(calls) })
    await api.hello.get()
    expect(calls[0]?.url).toBe('https://api.example.com/v2/_brust/action/hello')
  })

  test('invalid baseUrl (non-http(s)) throws at client() time', () => {
    expect(() => client<App>({ baseUrl: 'ftp://x' })).toThrow(
      'client baseUrl must be an absolute http(s) origin (got "ftp://x")',
    )
  })
})

describe('client calls', () => {
  test('GET builds params + query', async () => {
    const itemApp = new Elysia({ adapter: brust() }).get('/item/:id', ({ params }) => ({ id: params.id }))
    const calls: Call[] = []
    const api = client<typeof itemApp>({ fetch: stub(calls, '/_brust/action', itemApp as never) })
    const r = await api.item({ id: 'a b' }).get({ query: { x: '1' } })
    expect(calls[0]?.url).toBe('/_brust/action/item/a%20b?x=1')
    expect(r.data).toEqual({ id: 'a b' })
  })

  test('typed round trip', async () => {
    const api = client<App>({ fetch: stub([]) })
    const r = await api.team.post({ id: '1', name: 'a' })
    expect(r.status).toBe(200)
    expect(r.data?.max).toBe(6)
  })

  test('returned problem() is a typed error', async () => {
    const api = client<App>({ fetch: stub([]) })
    const r = await api.team.post({ id: 'full', name: 'a' })
    expect(r.error?.status).toBe(409)
    if (r.error?.status === 409) expect(r.error.value.max).toBe(6)
  })

  test('validation error → error.status 422, data null', async () => {
    const api = client<App>({ fetch: stub([]) })
    const r = await api.team.post({ id: 1, name: 'a' } as never)
    expect(r.error?.status).toBe(422)
    expect(r.data).toBeNull()
  })

  test('network failure resolves (Eden: status 503, not 0.1.x 0)', async () => {
    const boom = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const api = client<App>({ fetch: boom })
    const r = await api.hello.get()
    expect(r.status).toBe(503)
    expect(r.error?.value).toBeInstanceOf(Error)
  })

  test('fetch option is the transport; init carries RequestInit', async () => {
    const calls: Call[] = []
    const api = client<App>({ fetch: stub(calls), init: { credentials: 'include' } })
    await api.hello.get()
    expect(calls[0]?.init?.credentials).toBe('include')
  })

  test('headers may be a function evaluated per request, merged with per-call headers', async () => {
    const calls: Call[] = []
    let n = 0
    const api = client<App>({ fetch: stub(calls), headers: () => ({ 'x-n': String(++n) }) })
    await api.hello.get({ headers: { 'x-call': 'a' } })
    await api.hello.get()
    const h = (i: number) => new Headers(calls[i]?.init?.headers as HeadersInit)
    expect(h(0).get('x-n')).toBe('1')
    expect(h(0).get('x-call')).toBe('a')
    expect(h(1).get('x-n')).toBe('2')
  })
})

describe('client types', () => {
  test('type assertions (checked by typecheck)', () => {
    const api = client<App>({ fetch: stub([]) })
    const never = () => {
      // @ts-expect-error name is required by the body schema
      void api.team.post({ id: '1' })
      // @ts-expect-error unknown route
      void api.nope
    }
    expect(typeof never).toBe('function')
  })
})
