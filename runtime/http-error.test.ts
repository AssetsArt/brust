import { test, expect } from 'bun:test'
import {
  httpError,
  isHttpErrorTrigger,
  isNativeVerdict,
  notFound,
  prepReq,
  composeChain,
  runNativeChainLoaders,
  type BrustRequest,
  type HttpErrorTrigger,
  type Middleware,
  type Route,
  type RouteResponse,
} from './routes.ts'

function makeReq(over: Partial<BrustRequest> = {}): BrustRequest {
  return {
    method: 'GET',
    url: '/x',
    headers: {},
    cookies: {},
    search: {},
    signal: undefined as unknown as AbortSignal,
    params: {},
    locals: {},
    ...over,
  }
}

/** Capture the thrown trigger — httpError never returns. */
function capture(fn: () => never): HttpErrorTrigger {
  try {
    fn()
  } catch (e) {
    if (isHttpErrorTrigger(e)) return e
    throw e
  }
  throw new Error('unreachable')
}

// ----- httpError trigger shape -----

test('httpError throws a symbol-keyed trigger (never returns)', () => {
  const t = capture(() => httpError(403))
  expect(isHttpErrorTrigger(t)).toBe(true)
  expect(t.status).toBe(403)
})

test('httpError: string body → text/plain', () => {
  const t = capture(() => httpError(403, 'no entry'))
  expect(t.body).toBe('no entry')
  expect(t.contentType).toBe('text/plain; charset=utf-8')
})

test('httpError: omitted body → empty text/plain', () => {
  const t = capture(() => httpError(503))
  expect(t.body).toBe('')
  expect(t.contentType).toBe('text/plain; charset=utf-8')
})

test('httpError: object body → JSON', () => {
  const t = capture(() => httpError(422, { code: 'bad', n: 1 }))
  expect(JSON.parse(t.body)).toEqual({ code: 'bad', n: 1 })
  expect(t.contentType).toBe('application/json; charset=utf-8')
})

test('httpError: opts.contentType overrides the default', () => {
  const t = capture(() => httpError(403, '<h1>no</h1>', { contentType: 'text/html' }))
  expect(t.contentType).toBe('text/html')
})

test('httpError: opts.headers carried on the trigger', () => {
  const t = capture(() => httpError(403, 'no entry', { headers: { 'x-reason': 'test' } }))
  expect(t.headers).toEqual({ 'x-reason': 'test' })
})

// ----- status validation (programming errors throw a plain Error, loud) -----

test('httpError rejects out-of-range / non-integer statuses', () => {
  for (const bad of [399, 600, 200, 302, 404.5, Number.NaN]) {
    let err: unknown
    try {
      httpError(bad)
    } catch (e) {
      err = e
    }
    expect(isHttpErrorTrigger(err)).toBe(false)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('400-599')
  }
})

test('httpError accepts the 400 and 599 bounds', () => {
  expect(capture(() => httpError(400)).status).toBe(400)
  expect(capture(() => httpError(599)).status).toBe(599)
})

// ----- guard -----

test('isHttpErrorTrigger: false for plain values and lookalikes', () => {
  expect(isHttpErrorTrigger(null)).toBe(false)
  expect(isHttpErrorTrigger(undefined)).toBe(false)
  expect(isHttpErrorTrigger({})).toBe(false)
  expect(isHttpErrorTrigger({ status: 403, body: 'x' })).toBe(false)
  expect(isHttpErrorTrigger(new Error('403'))).toBe(false)
  // a notFound() verdict is a DIFFERENT symbol — never an httpError trigger
  expect(isHttpErrorTrigger(notFound())).toBe(false)
  expect(isNativeVerdict(capture(() => httpError(403)))).toBe(false)
})

// ----- prepReq -----

test('prepReq populates params and a fresh locals bag, returns the same req', () => {
  const req = { method: 'GET' } as unknown as BrustRequest
  const out = prepReq(req, { id: '42' })
  expect(out).toBe(req)
  expect(req.params).toEqual({ id: '42' })
  expect(req.locals).toEqual({})
})

test('prepReq: undefined params → empty object (SSE/WS envelopes)', () => {
  const req = {} as BrustRequest
  prepReq(req, undefined)
  expect(req.params).toEqual({})
})

test('prepReq resets locals per call (no cross-request leak)', () => {
  const req = {} as BrustRequest
  prepReq(req, {})
  req.locals.user = 'alice'
  prepReq(req, {})
  expect(req.locals).toEqual({})
})

// ----- composeChain locals identity (pure-function — no server) -----

test('composeChain: locals written in middleware are read by the terminal on the SAME object', async () => {
  const req = makeReq()
  const mw: Middleware = async (r, next) => {
    r.locals.user = 'alice'
    return next()
  }
  let seen: unknown
  let identity = false
  const terminal = async (): Promise<RouteResponse> => {
    seen = req.locals.user
    identity = req.locals === (req as BrustRequest).locals
    return { status: 200, body: 'ok' }
  }
  const res = await composeChain(req, [mw], terminal)()
  expect(res.status).toBe(200)
  expect(seen).toBe('alice')
  expect(identity).toBe(true)
})

test('composeChain: middleware sees req.params (authorize without URL parsing)', async () => {
  const req = makeReq({ params: { id: 'blocked' } })
  const mw: Middleware = async (r, next) => {
    if (r.params.id === 'blocked') return { status: 412, body: 'nope' }
    return next()
  }
  const res = await composeChain(req, [mw], async () => ({ status: 200, body: '' }))()
  expect(res.status).toBe(412)
})

// ----- runNativeChainLoaders httpError interception -----

test('runNativeChainLoaders: thrown httpError is intercepted per-loader (not a generic throw)', async () => {
  const chain: Route[] = [
    { path: 'a', loader: async () => ({ a: 1 }) },
    {
      path: 'b',
      loader: async () => {
        throw httpError(403, 'native no entry')
      },
    },
    {
      path: 'c',
      loader: async () => {
        throw new Error('must not run — chain short-circuited')
      },
    },
  ]
  const result = await runNativeChainLoaders(chain, { params: {}, path: '/x', req: makeReq() })
  if (!('httpError' in result)) throw new Error('expected httpError result')
  expect(result.httpError.status).toBe(403)
  expect(result.httpError.body).toBe('native no entry')
})

test('runNativeChainLoaders: non-trigger throws still propagate (500 contract unchanged)', async () => {
  const chain: Route[] = [
    {
      path: 'a',
      loader: async () => {
        throw new Error('boom')
      },
    },
  ]
  await expect(
    runNativeChainLoaders(chain, { params: {}, path: '/x', req: makeReq() }),
  ).rejects.toThrow('boom')
})
