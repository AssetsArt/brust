import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { loadActionsApp, mountActions } from '../src/actions/load'
import { prefixError } from '../src/actions/prefix'
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
      detail: { max: 6 },
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
