import { test, expect } from 'bun:test'
import { client } from './treaty.ts'

function fakeFetch(calls: any[]) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: init.body })
    return new Response(JSON.stringify({ echoed: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

test('GET builds prefixed URL with params + query', async () => {
  const calls: any[] = []
  const api = client<any>({ prefix: '/api', fetch: fakeFetch(calls) })
  const { data, status } = await api.notes({ id: 'x' }).get({ query: { verbose: 'true' } })
  expect(calls[0].url).toBe('/api/notes/x?verbose=true')
  expect(calls[0].method).toBe('GET')
  expect(status).toBe(200)
  expect(data).toEqual({ echoed: true })
})
test('POST sends JSON body', async () => {
  const calls: any[] = []
  const api = client<any>({ prefix: '/api', fetch: fakeFetch(calls) })
  await api.notes.post({ text: 'hi' })
  expect(calls[0].url).toBe('/api/notes')
  expect(calls[0].method).toBe('POST')
  expect(JSON.parse(calls[0].body)).toEqual({ text: 'hi' })
})
test('non-2xx populates error not data, never throws', async () => {
  const api = client<any>({
    prefix: '/api',
    fetch: async () => new Response('{"error":{"message":"nope"}}', { status: 422 }),
  })
  const { data, error, status } = await api.notes.post({})
  expect(data).toBeNull()
  expect(status).toBe(422)
  expect(error?.status).toBe(422)
})
test('network failure resolves as error status 0', async () => {
  const api = client<any>({
    prefix: '/api',
    fetch: async () => {
      throw new Error('offline')
    },
  })
  const { error } = await api.notes.get()
  expect(error?.status).toBe(0)
})
test('body with a Blob sends FormData, no json content-type', async () => {
  let captured: any
  const api = client<any>({
    prefix: '/api',
    fetch: (async (_u: string, init: any) => {
      captured = init
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any,
  })
  await api.upload.post({ name: 'x', file: new Blob(['hi'], { type: 'text/plain' }) })
  expect(captured.body instanceof FormData).toBe(true)
  expect((captured.headers as Record<string, string>)['content-type']).toBeUndefined()
})
test('FormData passed directly is sent as-is', async () => {
  let captured: any
  const api = client<any>({
    prefix: '/api',
    fetch: (async (_u: string, init: any) => {
      captured = init
      return new Response('{}', { status: 200 })
    }) as any,
  })
  const fd = new FormData()
  fd.append('a', '1')
  await api.upload.post(fd)
  expect(captured.body).toBe(fd)
})
// ─── baseUrl (cross-origin treaty) ──────────────────────────────────────────

test('baseUrl + default prefix targets the other origin under /_brust/action', async () => {
  const calls: any[] = []
  const api = client<any>({ baseUrl: 'https://api.example.com', fetch: fakeFetch(calls) })
  await api.notes.post({ text: 'hi' })
  expect(calls[0].url).toBe('https://api.example.com/_brust/action/notes')
})

test('baseUrl + custom prefix composes', async () => {
  const calls: any[] = []
  const api = client<any>({
    baseUrl: 'https://api.example.com',
    prefix: '/api',
    fetch: fakeFetch(calls),
  })
  await api.notes({ id: 'x' }).get()
  expect(calls[0].url).toBe('https://api.example.com/api/notes/x')
})

test('baseUrl trailing slash is stripped', async () => {
  const calls: any[] = []
  const api = client<any>({ baseUrl: 'https://api.example.com/', fetch: fakeFetch(calls) })
  await api.notes.get()
  expect(calls[0].url).toBe('https://api.example.com/_brust/action/notes')
})

test('baseUrl with a path suffix composes by concatenation', async () => {
  const calls: any[] = []
  const api = client<any>({ baseUrl: 'https://api.example.com/v2', fetch: fakeFetch(calls) })
  await api.notes.get()
  expect(calls[0].url).toBe('https://api.example.com/v2/_brust/action/notes')
})

test('invalid baseUrl (non-http(s)) throws at client() time', () => {
  expect(() => client<any>({ baseUrl: 'ftp://api.example.com' })).toThrow(/baseUrl/)
  expect(() => client<any>({ baseUrl: 'api.example.com' })).toThrow(/baseUrl/)
})

test('baseUrl never consults __BRUST_ACTION_PREFIX__; no-baseUrl still does', async () => {
  const g = globalThis as { __BRUST_ACTION_PREFIX__?: string }
  g.__BRUST_ACTION_PREFIX__ = '/custom-actions'
  try {
    const crossCalls: any[] = []
    const cross = client<any>({ baseUrl: 'https://api.example.com', fetch: fakeFetch(crossCalls) })
    await cross.notes.get()
    // The global belongs to the SERVING app — ignored under baseUrl.
    expect(crossCalls[0].url).toBe('https://api.example.com/_brust/action/notes')

    const sameCalls: any[] = []
    const same = client<any>({ fetch: fakeFetch(sameCalls) })
    await same.notes.get()
    // Unchanged same-origin behavior: the global still wins when baseUrl is absent.
    expect(sameCalls[0].url).toBe('/custom-actions/notes')
  } finally {
    delete g.__BRUST_ACTION_PREFIX__
  }
})

test('plain object still sends JSON (regression)', async () => {
  let captured: any
  const api = client<any>({
    prefix: '/api',
    fetch: (async (_u: string, init: any) => {
      captured = init
      return new Response('{}', { status: 200 })
    }) as any,
  })
  await api.notes.post({ text: 'hi' })
  expect(captured.body).toBe(JSON.stringify({ text: 'hi' }))
  expect((captured.headers as Record<string, string>)['content-type']).toBe('application/json')
})
