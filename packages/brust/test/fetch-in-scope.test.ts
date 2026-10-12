import { expect, test } from 'bun:test'
import { fetchInScope, noActions } from '../src/actions-bridge'
import { getServerInstance } from '../src/store/server-context'

const mk = () => ({ instance: {} })
const req = (path = '/x') => new Request(`http://localhost${path}`)

test('a store touched in app.fetch AND in a lazy body stream is in scope', async () => {
  const res = await fetchInScope(
    {
      fetch() {
        getServerInstance('s', mk)
        return new Response(
          new ReadableStream({
            start(c) {
              getServerInstance('s', mk)
              c.enqueue(new TextEncoder().encode('lazy'))
              c.close()
            },
          }),
        )
      },
    },
    req(),
  )
  expect(await res.text()).toBe('lazy')
  expect(() => getServerInstance('s', mk)).toThrow(/outside a request scope/)
})

test('status, headers and both set-cookie values survive', async () => {
  const h = new Headers({ 'x-a': '1' })
  h.append('set-cookie', 'a=1; Path=/')
  h.append('set-cookie', 'b=2; Path=/')
  const res = await fetchInScope({ fetch: () => new Response('hi', { status: 201, headers: h }) }, req())
  expect(res).toBeInstanceOf(Response)
  expect(res.status).toBe(201)
  expect(res.headers.get('x-a')).toBe('1')
  expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
  expect(await res.text()).toBe('hi')
})

test('204 and 304 replies have a null body', async () => {
  for (const status of [204, 304]) {
    const res = await fetchInScope({ fetch: () => new Response(null, { status }) }, req())
    expect(res.status).toBe(status)
    expect(res.body).toBeNull()
  }
})

test('noActions answers 500 text', async () => {
  const res = await noActions(req())
  expect(res.status).toBe(500)
  expect(await res.text()).toContain('not configured')
})
