import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { WebStandardAdapter } from 'elysia/adapter/web-standard'
import { brust, isBrustAdapter } from '../src/actions/elysia'

test('brust() is the web-standard adapter named brust', () => {
  const a = brust()
  expect(a.name).toBe('brust')
  expect(a.parse).toBe(WebStandardAdapter.parse)
  expect(a.response).toBe(WebStandardAdapter.response)
  expect(a.setup).toBeUndefined()
})

test('app.listen() throws the brust message', () => {
  expect(() => new Elysia({ adapter: brust() }).listen(3000)).toThrow('brust actions are served by the Rust server — remove app.listen()')
})

test('an app built on brust() answers through app.fetch (sync or async)', async () => {
  const app = new Elysia({ adapter: brust() }).get('/x', () => ({ ok: true }))
  const res = await Promise.resolve(app.fetch(new Request('http://l/x')))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})

test('each call returns a fresh adapter object', () => {
  expect(brust()).not.toBe(brust())
})

test('isBrustAdapter', () => {
  expect(isBrustAdapter(brust())).toBe(true)
  expect(isBrustAdapter(WebStandardAdapter)).toBe(false)
  expect(isBrustAdapter(undefined)).toBe(false)
  expect(isBrustAdapter({ name: 'other' })).toBe(false)
})
