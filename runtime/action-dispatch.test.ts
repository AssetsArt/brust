import { test, expect } from 'bun:test'
import { z } from 'zod'
import { defineActions } from './define-actions.ts'
import { dispatchAction } from './routes.ts'

function table(b: ReturnType<typeof defineActions>) {
  return new Map(b.endpoints.map((e, i) => [String(i), e]))
}
const reqBase = { headers: {}, cookies: {}, search: '' }

test('GET with params returns 200 JSON', async () => {
  const a = defineActions().get('/notes/{id}', ({ params }) => ({ id: params.id }))
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: '', params: { id: 'abc' }, req: { method: 'GET', ...reqBase } as any },
    table(a))
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ id: 'abc' })
})
test('POST validates body, 422 on bad input', async () => {
  const a = defineActions().post('/notes', ({ body }) => body, { body: z.object({ text: z.string() }) })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {}, body_text: JSON.stringify({ text: 123 }), req: { method: 'POST', ...reqBase } as any },
    table(a))
  expect(res.status).toBe(422)
  expect(JSON.parse(res.body).error.issues).toBeDefined()
})
test('POST valid body returns 200', async () => {
  const a = defineActions().post('/notes', ({ body }) => ({ got: body.text }), { body: z.object({ text: z.string() }) })
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {}, body_text: JSON.stringify({ text: 'hi' }), req: { method: 'POST', ...reqBase } as any },
    table(a))
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ got: 'hi' })
})
test('respond() sentinel controls status', async () => {
  const a = defineActions().post('/x', ({ respond }) => respond({ ok: true }, { status: 201 }))
  const res = await dispatchAction(
    { kind: 'action', action_id: '0', content_type: 'application/json', params: {}, body_text: 'null', req: { method: 'POST', ...reqBase } as any },
    table(a))
  expect(res.status).toBe(201)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
})
test('unknown action_id → 404', async () => {
  const res = await dispatchAction(
    { kind: 'action', action_id: '99', content_type: '', params: {}, req: { method: 'GET', ...reqBase } as any },
    new Map())
  expect(res.status).toBe(404)
})
