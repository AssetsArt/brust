import { test, expect } from 'bun:test'
import { flattenRoutes, joinPath, type Route } from './routes.ts'

// Minimal component stub used in fixtures.
const C: any = () => null

test('joinPath: empty base + relative child', () => {
  expect(joinPath('', 'users')).toBe('/users')
})

test('joinPath: non-empty base + relative child', () => {
  expect(joinPath('/admin', 'users')).toBe('/admin/users')
})

test('joinPath: base with trailing slash collapses', () => {
  expect(joinPath('/admin/', 'users')).toBe('/admin/users')
})

test('joinPath: empty relative returns base unchanged (layout-only)', () => {
  expect(joinPath('/admin', '')).toBe('/admin')
})

test('joinPath: absolute child under empty parent (layout-only) keeps absolute', () => {
  expect(joinPath('', '/users')).toBe('/users')
})

test('flattenRoutes: empty input', () => {
  expect(flattenRoutes([])).toEqual([])
})

test('flattenRoutes: flat route stays single-entry chain', () => {
  const out = flattenRoutes([{ path: '/foo', Component: C }])
  expect(out).toHaveLength(1)
  expect(out[0].fullPath).toBe('/foo')
  expect(out[0].chain).toHaveLength(1)
  expect(out[0].chain[0].path).toBe('/foo')
  expect(out[0].middleware).toEqual([])
  expect(out[0].errorBoundary).toBeUndefined()
})

test('flattenRoutes: two-level nesting composes paths', () => {
  const out = flattenRoutes([
    {
      path: '/admin',
      Component: C,
      children: [
        { path: 'users', Component: C },
        { path: 'users/{id}', Component: C },
      ],
    },
  ])
  expect(out.map((r) => r.fullPath).sort()).toEqual(['/admin/users', '/admin/users/{id}'])
  expect(out[0].chain).toHaveLength(2)
})

test('flattenRoutes: index route matches parent path exactly', () => {
  const out = flattenRoutes([
    {
      path: '/admin',
      Component: C,
      children: [{ index: true, Component: C }],
    },
  ])
  expect(out).toHaveLength(1)
  expect(out[0].fullPath).toBe('/admin')
  expect(out[0].chain).toHaveLength(2)
})

test('flattenRoutes: layout-only parent passes children through', () => {
  const out = flattenRoutes([
    {
      path: '',
      Component: C,
      children: [{ path: '/dashboard', Component: C }],
    },
  ])
  expect(out).toHaveLength(1)
  expect(out[0].fullPath).toBe('/dashboard')
  expect(out[0].chain).toHaveLength(2)
})

test('flattenRoutes: middleware concatenated parent-first', () => {
  const mwA = async (_: any, n: any) => n()
  const mwB = async (_: any, n: any) => n()
  const mwC = async (_: any, n: any) => n()
  const out = flattenRoutes([
    {
      path: '/a',
      Component: C,
      middleware: [mwA, mwB],
      children: [{ path: 'b', Component: C, middleware: [mwC] }],
    },
  ])
  expect(out[0].middleware).toEqual([mwA, mwB, mwC])
})

test('flattenRoutes: errorBoundary leaf takes priority', () => {
  const ParentEB: any = () => null
  const ChildEB: any = () => null
  const out = flattenRoutes([
    {
      path: '/a',
      Component: C,
      errorBoundary: ParentEB,
      children: [{ path: 'b', Component: C, errorBoundary: ChildEB }],
    },
  ])
  expect(out[0].errorBoundary).toBe(ChildEB)
})

test('flattenRoutes: errorBoundary falls back to parent when leaf has none', () => {
  const ParentEB: any = () => null
  const out = flattenRoutes([
    {
      path: '/a',
      Component: C,
      errorBoundary: ParentEB,
      children: [{ path: 'b', Component: C }],
    },
  ])
  expect(out[0].errorBoundary).toBe(ParentEB)
})

test('flattenRoutes: cache from leaf only, parent ignored when chain > 1', () => {
  const out = flattenRoutes([
    {
      path: '/a',
      Component: C,
      cache: { ttl_seconds: 60 },
      children: [{ path: 'b', Component: C }],
    },
  ])
  expect(out[0].cache).toBeUndefined()
})

test('flattenRoutes: throws when index combined with path', () => {
  expect(() =>
    flattenRoutes([{ path: '/a', Component: C, children: [{ index: true, path: 'b', Component: C }] }]),
  ).toThrow(/cannot set both index and path/)
})

test('flattenRoutes: throws when index has children', () => {
  expect(() =>
    flattenRoutes([
      { path: '/a', Component: C, children: [{ index: true, Component: C, children: [{ path: 'x', Component: C }] }] },
    ]),
  ).toThrow(/index route cannot have children/)
})

test('flattenRoutes: throws when route has neither path, index, nor children', () => {
  expect(() => flattenRoutes([{ Component: C } as Route])).toThrow(/must have path, index, or children/)
})

test('flattenRoutes: throws on absolute child path under non-empty parent', () => {
  expect(() =>
    flattenRoutes([
      { path: '/a', Component: C, children: [{ path: '/escape', Component: C }] },
    ]),
  ).toThrow(/absolute child path/)
})

// ----- SSE validation tests (Task 9) -----

test('flattenRoutes rejects sse + Component', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', sse: () => new ReadableStream(), Component: C },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'Component'/)
})

test('flattenRoutes rejects sse + loader', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', sse: () => new ReadableStream(), loader: async () => ({}) },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'loader'/)
})

test('flattenRoutes rejects sse + children', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', sse: () => new ReadableStream(), children: [{ path: 'y', Component: C }] },
    ] as Route[]),
  ).toThrow(/nested children/)
})

test('flattenRoutes accepts sse + middleware', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', sse: () => new ReadableStream(), middleware: [] },
    ] as Route[]),
  ).not.toThrow()
})

// ----- WS validation tests (Task 10) -----

test('flattenRoutes rejects websocket + Component', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', websocket: async () => ({}), Component: C },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'Component'/)
})

test('flattenRoutes rejects websocket + loader', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', websocket: async () => ({}), loader: async () => ({}) },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'loader'/)
})

test('flattenRoutes rejects websocket + sse', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', websocket: async () => ({}), sse: () => new ReadableStream() },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'sse'/)
})

test('flattenRoutes accepts websocket + middleware', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', websocket: async () => ({}), middleware: [] },
    ] as Route[]),
  ).not.toThrow()
})

// ----- A2.2 rustCompiled validation tests -----

test('flattenRoutes accepts rustCompiled as the only render mechanism', () => {
  const flat = flattenRoutes([
    { path: '/', rustCompiled: 'static_hello' },
  ] as Route[])
  expect(flat.length).toBe(1)
  expect(flat[0]!.rustCompiled).toBe('static_hello')
  expect(flat[0]!.fullPath).toBe('/')
})

test('flattenRoutes rejects rustCompiled + Component', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', rustCompiled: 'static_hello', Component: C },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'Component'/)
})

test('flattenRoutes rejects rustCompiled + loader (in A2.2)', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', rustCompiled: 'static_hello', loader: async () => ({}) },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'loader'/)
})

test('flattenRoutes rejects rustCompiled + middleware (in A2.2)', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', rustCompiled: 'static_hello', middleware: [async (_, next) => next()] },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'middleware'/)
})

test('flattenRoutes rejects rustCompiled + sse', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', rustCompiled: 'static_hello', sse: () => new ReadableStream() },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'sse'/)
})

test('flattenRoutes rejects rustCompiled + children', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', rustCompiled: 'static_hello', children: [{ path: 'y', Component: C }] },
    ] as Route[]),
  ).toThrow(/nested children/)
})
