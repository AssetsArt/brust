import { expect, test } from 'bun:test'
import { defineRoutes, flattenRoutes, httpError, isHttpErrorTrigger, isVerdict, notFound, Outlet, redirect } from '../src/routes'

const L = () => null,
  H = () => null,
  D = () => null,
  N = () => null

test('defineRoutes rejects every non-M2 field with the M3 message', () => {
  for (const field of ['native', 'errorBoundary', 'ssg', 'middleware', 'sse', 'websocket', 'index'])
    expect(() => defineRoutes([{ path: '/', Component: H, [field]: 1 } as any])).toThrow(`${field} is not supported in M2 (M3)`)
  expect(() => defineRoutes([{ path: '/', Component: H, cache: { ttl_seconds: 1, key: () => 'k' } } as any])).toThrow('cache.key is not supported in M2 (M3)')
  expect(() => defineRoutes([{ path: '/x', children: [{ Component: H }] }])).toThrow(/leaf .* needs a path/)
  expect(() => defineRoutes([{ path: '*', Component: N, children: [{ path: '/a', Component: H }] }])).toThrow(/'\*' must be a leaf/)
})

test('flattenRoutes assigns DFS ids, patterns and chains', () => {
  const routes = defineRoutes([
    {
      Component: L,
      loader: async () => ({ a: 1 }),
      children: [{ path: '/', Component: H }, { path: '/items/{id}', Component: D, loader: async () => ({}) }, { path: '*', Component: N }],
    },
  ])
  const { leaves, nodes } = flattenRoutes(routes)
  expect([...nodes.values()]).toEqual(['r0', 'r1', 'r2', 'r3'])
  expect(leaves.map((l) => [l.id, l.pattern, l.chainIds, l.catchAll])).toEqual([
    ['r1', '/', ['r0', 'r1'], false],
    ['r2', '/items/{id}', ['r0', 'r2'], false],
    ['r3', '*', ['r0', 'r3'], true],
  ])
  expect(leaves[1]!.chain.map((r) => r.Component)).toEqual([L, D])
})

test('verdicts keep the 0.1.x wire shape', () => {
  expect(notFound()).toMatchObject({ status: 404, render: true, data: {} })
  expect(isVerdict({ status: 404 })).toBe(false)
  expect(redirect('/x')).toMatchObject({ status: 302, headers: { Location: '/x' } })
  let caught: unknown
  try {
    httpError(418, 'teapot')
  } catch (e) {
    caught = e
  }
  expect(isHttpErrorTrigger(caught)).toBe(true)
  expect(caught).toMatchObject({ status: 418, body: 'teapot', contentType: 'text/plain; charset=utf-8' })
  expect(() => httpError(302, '')).toThrow(/400-599/)
  expect(Outlet()).toBeNull()
})

test("'*' only at the root (M2): a nested catch-all throws, a second one is duplicate-catch-all", () => {
  expect(() => defineRoutes([{ path: '/docs', children: [{ path: '*', Component: N }] }])).toThrow(
    "'*' is only supported at the root in M2 (M3)",
  )
  expect(() => defineRoutes([{ path: '/docs', Component: L, children: [{ path: '/a', children: [{ path: '*', Component: N }] }] }])).toThrow(
    "'*' is only supported at the root in M2 (M3)",
  )
  // Pathless and `/` layouts keep the root prefix: still the site-wide catch-all, pattern `*`.
  const ok = defineRoutes([{ path: '/', Component: L, children: [{ path: '*', Component: N }] }])
  expect(flattenRoutes(ok).leaves.map((l) => l.pattern)).toEqual(['*'])
  expect(() => defineRoutes([{ Component: L, children: [{ path: '*', Component: N }] }, { path: '*', Component: N }])).toThrow(
    /duplicate-catch-all|more than one/,
  )
  try {
    defineRoutes([{ path: '/docs', children: [{ path: '*', Component: N }] }])
  } catch (e) {
    expect(e).toMatchObject({ rule: 'nested-catch-all' })
  }
  try {
    defineRoutes([{ path: '*', Component: N }, { path: '*', Component: H }])
  } catch (e) {
    expect(e).toMatchObject({ rule: 'duplicate-catch-all' })
  }
})

test('route cache: ttl_seconds a non-negative integer, tags string[], prefix string, bypass true|string', () => {
  const r = (cache: unknown) => () => defineRoutes([{ path: '/', Component: H, cache } as any])
  expect(r({ ttl_seconds: 1.5 })).toThrow('cache.ttl_seconds must be a non-negative integer')
  expect(r({ ttl_seconds: -1 })).toThrow('cache.ttl_seconds must be a non-negative integer')
  expect(r({ ttl_seconds: Number.MAX_SAFE_INTEGER + 2 })).toThrow('cache.ttl_seconds must be a non-negative integer')
  expect(r({ ttl_seconds: 60, tags: 'a' })).toThrow('cache.tags must be an array of strings')
  expect(r({ ttl_seconds: 60, tags: ['a', 1] })).toThrow('cache.tags must be an array of strings')
  expect(r({ ttl_seconds: 60, prefix: 1 })).toThrow('cache.prefix must be a string')
  expect(r({ ttl_seconds: 60, bypass: false })).toThrow("cache.bypass must be true or a string")
  expect(r({ ttl_seconds: 60, bypass: 1 })).toThrow("cache.bypass must be true or a string")
  expect(r({ ttl_seconds: 0, tags: ['a'], prefix: 'p', bypass: true })).not.toThrow()
  expect(r({ ttl_seconds: 60, bypass: 'nocache' })).not.toThrow()
})

test('cache on a layout route (has children) is rejected in M2', () => {
  expect(() => defineRoutes([{ path: '/', Component: L, cache: { ttl_seconds: 60 }, children: [{ path: '/a', Component: H }] }])).toThrow(
    'cache on a layout route is not supported in M2 (M3)',
  )
})
