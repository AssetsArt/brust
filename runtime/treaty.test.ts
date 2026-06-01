import { test, expect } from 'bun:test'
import { client } from './treaty.ts'

function fakeFetch(calls: any[]) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: init.body })
    return new Response(JSON.stringify({ echoed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
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
  const api = client<any>({ prefix: '/api', fetch: async () => new Response('{"error":{"message":"nope"}}', { status: 422 }) })
  const { data, error, status } = await api.notes.post({})
  expect(data).toBeNull()
  expect(status).toBe(422)
  expect(error?.status).toBe(422)
})
test('network failure resolves as error status 0', async () => {
  const api = client<any>({ prefix: '/api', fetch: async () => { throw new Error('offline') } })
  const { error } = await api.notes.get()
  expect(error?.status).toBe(0)
})
