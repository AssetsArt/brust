import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { brust } from '../src/actions/elysia'
import { loadActionsApp, mountActions, shadowedGetActions, streamRouteCheck } from '../src/actions/load'
import { prefixError, streamEntryError } from '../src/actions/prefix'
import app from './fixtures/actions/app'

const m = mountActions(app, '/_brust/action')
const call = (p: string, init?: RequestInit) =>
  Promise.resolve(m.fetch(new Request(`http://l${p}`, init)))
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('mountActions', () => {
  test('GET with a query answers JSON', async () => {
    const r = await call('/_brust/action/hello?name=ash')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ hi: 'ash' })
  })

  test('POST JSON answers 200 and sets the cookie', async () => {
    const r = await call('/_brust/action/team', json({ id: 'a', name: 'b' }))
    expect(r.status).toBe(200)
    expect(r.headers.getSetCookie().join('|')).toContain('sid=abc; Path=/')
  })

  test('invalid body -> 422 application/problem+json', async () => {
    const r = await call('/_brust/action/team', json({ id: 1 }))
    expect(r.status).toBe(422)
    expect(r.headers.get('content-type')).toContain('application/problem+json')
    expect(await r.json()).toMatchObject({ type: 'validation', status: 422 })
  })

  test('returned problem() -> 409 problem+json with extension members', async () => {
    const r = await call('/_brust/action/team', json({ id: 'full', name: 'x' }))
    expect(r.status).toBe(409)
    expect(r.headers.get('content-type')).toContain('application/problem+json')
    expect(await r.json()).toMatchObject({
      type: 'about:blank',
      title: 'Team full',
      status: 409,
      max: 6,
    })
  })

  test('thrown HTTPError -> 409 problem+json', async () => {
    const r = await call('/_brust/action/thrown')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({
      type: 'TEAM_FULL',
      code: 'TEAM_FULL',
      max: 6, // the class's extension() members sit on the problem document (rc.0; beta.30 nested them under detail)
      status: 409,
    })
  })

  test('two cookies survive as two Set-Cookie headers', async () => {
    const r = await call('/_brust/action/cookies')
    expect(r.headers.getSetCookie().length).toBe(2)
  })

  test('prefix edges', async () => {
    expect(await (await call('/_brust/action')).text()).toBe('root')
    expect(await (await call('/_brust/action/')).text()).toBe('root')
    expect((await call('/_brust/actionx')).status).toBe(404)
    expect((await call('/hello')).status).toBe(404)
    expect(await (await call('/_brust/action/url')).json()).toEqual({ path: '/_brust/action/url' })
  })

  test("a wrong method under the prefix is Elysia's 404 problem", async () => {
    const r = await call('/_brust/action/hello', { method: 'PUT' })
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toContain('application/problem+json')
  })

  test('mountActions refuses', () => {
    expect(() => mountActions(undefined, '/p')).toThrow(/no default export/)
    expect(() => mountActions({}, '/p')).toThrow(/not an Elysia app/)
    expect(() => mountActions(new Elysia(), '/p')).toThrow(/new Elysia\(\{ adapter: brust\(\) \}\)/)
  })

  test('loadActionsApp imports the file and mounts its default export', async () => {
    const a = await loadActionsApp(join(import.meta.dir, 'fixtures/actions/app.ts'), '/p')
    const r = await Promise.resolve(a.fetch(new Request('http://l/p/hello')))
    expect(r.status).toBe(200)
  })
})

describe('prefixError', () => {
  test('prefixError', () => {
    for (const p of ['/_brust/action', '/api', '/v1/actions', '/_brust/action/x'])
      expect(prefixError(p)).toBeNull()
    for (const p of ['', 'api', '/', '/api/', '//a', '/a/../b', '/a b', '/_brust', '/_brust/client'])
      expect(typeof prefixError(p)).toBe('string')
  })
})

test('shadowedGetActions: the GET actions a route under the prefix hides (F470)', () => {
  const a = mountActions(
    new Elysia({ adapter: brust() })
      .get('/google/callback', () => 'g')
      .get('/:provider/start', () => 's')
      .post('/apple/callback', () => 'a')
      .get('/session', () => 'x'),
    '/auth',
  )
  expect(shadowedGetActions(a, ['/', '/auth/{provider}/callback', '/auth/{provider}/start', '/other/session'], '/auth')).toEqual([
    'GET /auth/google/callback (route /auth/{provider}/callback)',
    'GET /auth/:provider/start (route /auth/{provider}/start)',
  ])
  expect(shadowedGetActions(a, ['/', '/elsewhere'], '/auth')).toEqual([])
})

test('streamRouteCheck: listed entries need a { parse: none } route; unlisted parse-none routes are reported (F475)', () => {
  const a = mountActions(
    new Elysia({ adapter: brust() })
      .post('/upload', { parse: 'none' }, () => 'u')
      .put('/files/:id', { parse: 'none' }, () => 'f')
      .patch('/raw', { parse: 'none' }, () => 'r')
      .post('/json', () => 'j'),
    '/api',
  )
  expect(streamRouteCheck(a, ['POST /upload', 'PUT /files/:name'], '/api')).toEqual({ missing: [], parsed: [], unlisted: ['PATCH /api/raw'] })
  // A parsed route, a wrong method, or no route at all is missing.
  expect(streamRouteCheck(a, ['POST /json', 'PUT /upload', 'POST /nope'], '/api').missing).toEqual(['POST /json', 'PUT /upload', 'POST /nope'])
  expect(streamRouteCheck(a, [], '/api').unlisted).toEqual(['POST /api/upload', 'PUT /api/files/:id', 'PATCH /api/raw'])
  // The root prefix of an actions-only build adds nothing.
  const root = mountActions(new Elysia({ adapter: brust() }).post('/up', { parse: 'none' }, () => 'u'), '/')
  expect(streamRouteCheck(root, ['POST /up'], '/')).toEqual({ missing: [], parsed: [], unlisted: [] })
})

test('streamRouteCheck: a parsing route a listed :param or * entry can reach is reported (F475)', () => {
  const a = mountActions(
    new Elysia({ adapter: brust() })
      .put('/files/*', { parse: 'none' }, () => 'f')
      .put('/files/special', () => 's')
      .put('/files/a/b', () => 'ab')
      .post('/files/x', () => 'x')
      .put('/files', () => 'root')
      .post('/u/:id', { parse: 'none' }, () => 'u')
      .post('/u/me', () => 'me')
      .post('/v/:id', () => 'v'),
    '/api',
  )
  expect(streamRouteCheck(a, ['PUT /files/*', 'POST /u/:id'], '/api').parsed).toEqual(['PUT /api/files/special', 'PUT /api/files/a/b', 'POST /api/u/me'])
  // An entry for a static path reaches a parsing :param route too.
  const b = mountActions(new Elysia({ adapter: brust() }).post('/v/me', { parse: 'none' }, () => 'me').post('/v/:id', () => 'v'), '/api')
  expect(streamRouteCheck(b, ['POST /v/me'], '/api').parsed).toEqual(['POST /api/v/:id'])
})

test('streamEntryError mirrors the Rust StreamRoute rules (F475)', () => {
  for (const ok of ['POST /upload', 'put /files/*', 'PATCH /a/:id/b', 'POST /']) expect(streamEntryError(ok)).toBeNull()
  for (const bad of ['GET /x', 'POST upload', 'POST /a//b', 'POST /a/*/b', 'POST /a*', '/upload', 1]) expect(streamEntryError(bad)).not.toBeNull()
})
