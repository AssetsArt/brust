import { test, expect } from 'bun:test'
import { z } from 'zod'
import { defineActions } from '../define-actions.ts'
import { makeMcpServer } from './server.ts'
import type { McpManifest } from './manifest.ts'

const reqBase = { method: 'POST', headers: {}, cookies: {}, search: '' } as any

function setup() {
  const actions = defineActions()
    .post('/notes', ({ body }) => ({ id: 'n-' + (body as { text: string }).text.length }), {
      body: z.object({ text: z.string() }),
    })
    .delete('/notes/{id}', ({ params }) => ({ ok: true, id: params.id }), {
      middleware: [async (req, next) => (req.cookies.user ? next() : { status: 401, body: 'no' })],
    })
  const manifest: McpManifest = {
    version: 1,
    tools: [
      {
        name: 'post_notes',
        method: 'POST',
        path: '/notes',
        inputSchema: { type: 'object', properties: { body: { type: 'object' } } },
      },
      {
        name: 'delete_notes_by_id',
        method: 'DELETE',
        path: '/notes/{id}',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    resources: [],
  }
  return makeMcpServer({ manifest, endpoints: actions.endpoints, routes: [] })
}

async function call(
  srv: ReturnType<typeof makeMcpServer>,
  method: string,
  params: unknown,
  req = reqBase,
) {
  const out = await srv.handleRequest(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    req,
  )
  return JSON.parse(out)
}

test('tools/list returns manifest tools', async () => {
  const r = await call(setup(), 'tools/list', undefined)
  expect(r.result.tools.map((t: any) => t.name)).toEqual(['post_notes', 'delete_notes_by_id'])
})

test('tools/call post_notes success', async () => {
  const r = await call(setup(), 'tools/call', {
    name: 'post_notes',
    arguments: { body: { text: 'hi' } },
  })
  expect(r.result.isError).toBe(false)
  expect(JSON.parse(r.result.content[0].text)).toEqual({ id: 'n-2' })
})

test('tools/call post_notes 422 on bad body', async () => {
  const r = await call(setup(), 'tools/call', { name: 'post_notes', arguments: { body: {} } })
  expect(r.result.isError).toBe(true)
  expect(r.result.content[0].text).toContain('validation')
})

test('tools/call middleware short-circuit (no cookie → isError)', async () => {
  const r = await call(
    setup(),
    'tools/call',
    { name: 'delete_notes_by_id', arguments: { params: { id: 'x' } } },
    { ...reqBase, method: 'DELETE', cookies: {} },
  )
  expect(r.result.isError).toBe(true)
})

test('tools/call middleware passes with cookie', async () => {
  const r = await call(
    setup(),
    'tools/call',
    { name: 'delete_notes_by_id', arguments: { params: { id: 'x' } } },
    { ...reqBase, method: 'DELETE', cookies: { user: 'alice' } },
  )
  expect(r.result.isError).toBe(false)
  expect(JSON.parse(r.result.content[0].text)).toEqual({ ok: true, id: 'x' })
})

test('tools/call unknown tool → -32601', async () => {
  const r = await call(setup(), 'tools/call', { name: 'nope', arguments: {} })
  expect(r.error.code).toBe(-32601)
})
