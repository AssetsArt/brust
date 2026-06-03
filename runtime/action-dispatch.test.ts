import { test, expect } from 'bun:test'
import { z } from 'zod'
import { ActionError } from './action-error.ts'
import { cookies } from './cookies.ts'
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

test('handler throws ActionError → typed status + flat body', async () => {
  const a = defineActions().post('/t', () => {
    throw new ActionError(409, 'TEAM_FULL', { data: { max: 6 } })
  })
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
  expect(res.status).toBe(409)
  expect(JSON.parse(res.body)).toEqual({
    code: 'TEAM_FULL',
    message: 'TEAM_FULL',
    data: { max: 6 },
  })
})

// `data` key is absent (not `data: undefined`): actionErrorResponse only adds it
// when present, and toEqual treats a missing key vs an explicit-undefined as unequal.
test('ActionError without data omits data key', async () => {
  const a = defineActions().post('/t', () => {
    throw new ActionError(400, 'BAD', { message: 'nope' })
  })
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
  expect(res.status).toBe(400)
  expect(JSON.parse(res.body)).toEqual({ code: 'BAD', message: 'nope' })
})

test('non-ActionError throw → still 500 enveloped (regression)', async () => {
  const a = defineActions().post('/t', () => {
    throw new Error('boom')
  })
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
  expect(res.status).toBe(500)
  expect(JSON.parse(res.body)).toEqual({ error: { message: 'boom', name: 'Error' } })
})

test('middleware throws ActionError → same typed body as terminal (outer catch)', async () => {
  const mw = async (_req: any, _next: any) => {
    throw new ActionError(403, 'FORBIDDEN', { data: { reason: 'x' } })
  }
  const a = defineActions().post('/t', () => ({ ok: true }), { middleware: [mw] })
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
  expect(res.status).toBe(403)
  expect(JSON.parse(res.body)).toEqual({
    code: 'FORBIDDEN',
    message: 'FORBIDDEN',
    data: { reason: 'x' },
  })
})

test('respond() then throw ActionError → throw wins', async () => {
  const a = defineActions().post('/t', ({ respond }) => {
    respond({ ok: true }, { status: 201 })
    throw new ActionError(409, 'TEAM_FULL')
  })
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
  expect(res.status).toBe(409)
  expect(JSON.parse(res.body)).toEqual({ code: 'TEAM_FULL', message: 'TEAM_FULL' })
})

test('cookies.set in a handler flushes onto the response Set-Cookie header', async () => {
  const a = defineActions().post('/t', () => {
    cookies.set('mode', 'dark', { path: '/' })
    return { ok: true }
  })
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
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
  expect(res.headers?.['set-cookie']).toContain('mode=dark')
  expect(res.headers?.['set-cookie']).toContain('Path=/')
})

test('explicit respond({headers:{set-cookie}}) wins over cookies.set', async () => {
  const a = defineActions().post('/t', ({ respond }) => {
    cookies.set('mode', 'dark')
    return respond({ ok: true }, { headers: { 'set-cookie': 'x=1' } })
  })
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
  expect(res.headers?.['set-cookie']).toBe('x=1')
})

test('no cookies.set → no set-cookie header', async () => {
  const a = defineActions().post('/t', () => ({ ok: true }))
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
  expect(res.headers?.['set-cookie']).toBeUndefined()
})
