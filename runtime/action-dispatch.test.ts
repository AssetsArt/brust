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
    {
      kind: 'action',
      action_id: '0',
      content_type: '',
      params: { id: 'abc' },
      req: { method: 'GET', ...reqBase } as any,
    },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ id: 'abc' })
})
test('POST validates body, 422 on bad input', async () => {
  const a = defineActions().post('/notes', ({ body }) => body, {
    body: z.object({ text: z.string() }),
  })
  const res = await dispatchAction(
    {
      kind: 'action',
      action_id: '0',
      content_type: 'application/json',
      params: {},
      body_text: JSON.stringify({ text: 123 }),
      req: { method: 'POST', ...reqBase } as any,
    },
    table(a),
  )
  expect(res.status).toBe(422)
  expect(JSON.parse(res.body).error.issues).toBeDefined()
})
test('POST valid body returns 200', async () => {
  const a = defineActions().post('/notes', ({ body }) => ({ got: body.text }), {
    body: z.object({ text: z.string() }),
  })
  const res = await dispatchAction(
    {
      kind: 'action',
      action_id: '0',
      content_type: 'application/json',
      params: {},
      body_text: JSON.stringify({ text: 'hi' }),
      req: { method: 'POST', ...reqBase } as any,
    },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ got: 'hi' })
})
test('respond() sentinel controls status', async () => {
  const a = defineActions().post('/x', ({ respond }) => respond({ ok: true }, { status: 201 }))
  const res = await dispatchAction(
    {
      kind: 'action',
      action_id: '0',
      content_type: 'application/json',
      params: {},
      body_text: 'null',
      req: { method: 'POST', ...reqBase } as any,
    },
    table(a),
  )
  expect(res.status).toBe(201)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
})
test('unknown action_id → 404', async () => {
  const res = await dispatchAction(
    {
      kind: 'action',
      action_id: '99',
      content_type: '',
      params: {},
      req: { method: 'GET', ...reqBase } as any,
    },
    new Map(),
  )
  expect(res.status).toBe(404)
})
test('HEAD endpoint accumulates + dispatches bodyless', async () => {
  const a = defineActions().head('/notes/{id}', ({ params }) => ({ seen: params.id }))
  const res = await dispatchAction(
    {
      kind: 'action',
      action_id: '0',
      content_type: '',
      params: { id: 'z' },
      req: { method: 'HEAD', ...reqBase } as any,
    },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ seen: 'z' })
})
test('urlencoded body coerces to object and validates', async () => {
  const a = defineActions().post('/f', ({ body }) => body, {
    body: z.object({ a: z.string(), b: z.string() }),
  })
  const res = await dispatchAction(
    {
      kind: 'action',
      action_id: '0',
      content_type: 'application/x-www-form-urlencoded',
      params: {},
      body_text: 'a=1&b=hi',
      req: { method: 'POST', ...reqBase } as any,
    },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ a: '1', b: 'hi' })
})

test('multipart body coerces (text fields + File) and validates', async () => {
  const fd = new FormData()
  fd.append('name', 'alice')
  fd.append('file', new File(['hi'], 'h.txt', { type: 'text/plain' }))
  const wire = new Request('http://x', { method: 'POST', body: fd })
  const ct = wire.headers.get('content-type')!
  const b64 = Buffer.from(new Uint8Array(await wire.arrayBuffer())).toString('base64')
  const a = defineActions().post(
    '/u',
    ({ body }) => ({ name: (body as any).name, fileName: (body as any).file?.name }),
    {
      body: z.object({ name: z.string(), file: z.instanceof(File) }),
    },
  )
  const res = await dispatchAction(
    {
      kind: 'action',
      action_id: '0',
      content_type: ct,
      params: {},
      body_b64: b64,
      req: { method: 'POST', ...reqBase } as any,
    },
    table(a),
  )
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ name: 'alice', fileName: 'h.txt' })
})

test('malformed multipart → 400', async () => {
  const a = defineActions().post('/u', ({ body }) => body)
  const res = await dispatchAction(
    {
      kind: 'action',
      action_id: '0',
      content_type: 'multipart/form-data; boundary=----x',
      params: {},
      body_b64: Buffer.from('garbage not multipart').toString('base64'),
      req: { method: 'POST', ...reqBase } as any,
    },
    table(a),
  )
  expect(res.status).toBe(400)
})

test('duplicate HEAD path throws', () => {
  expect(() =>
    defineActions()
      .head('/x', () => ({}))
      .head('/x', () => ({})),
  ).toThrow(/duplicate/)
})
