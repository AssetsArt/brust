import { afterEach, expect, test } from 'bun:test'
import { __resetPagesForTest, pages } from './pages.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  __resetPagesForTest()
})

test('pages fetches and caches the v1 manifest', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json({
      version: 1,
      pages: [
        { path: '/pokemon/{id}', params: ['id'], catchAll: false, kind: 'react', shellId: 's1' },
      ],
    })
  }) as typeof fetch
  expect(await pages()).toEqual([
    { path: '/pokemon/{id}', params: ['id'], catchAll: false, kind: 'react', shellId: 's1' },
  ])
  await pages()
  expect(calls).toBe(1)
})

test('pages returns the not-found manifest hint when serving fails', async () => {
  globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch
  expect(await pages()).toMatchObject({
    ok: false,
    error: { code: 'not-found', hint: 'ai manifest not served — is the ai flag enabled?' },
  })
})
