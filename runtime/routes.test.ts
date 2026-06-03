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
    flattenRoutes([
      { path: '/a', Component: C, children: [{ index: true, path: 'b', Component: C }] },
    ]),
  ).toThrow(/cannot set both index and path/)
})

test('flattenRoutes: throws when index has children', () => {
  expect(() =>
    flattenRoutes([
      {
        path: '/a',
        Component: C,
        children: [{ index: true, Component: C, children: [{ path: 'x', Component: C }] }],
      },
    ]),
  ).toThrow(/index route cannot have children/)
})

test('flattenRoutes: throws when route has neither path, index, nor children', () => {
  expect(() => flattenRoutes([{ Component: C } as Route])).toThrow(
    /must have path, index, or children/,
  )
})

test('flattenRoutes: throws on absolute child path under non-empty parent', () => {
  expect(() =>
    flattenRoutes([{ path: '/a', Component: C, children: [{ path: '/escape', Component: C }] }]),
  ).toThrow(/absolute child path/)
})

// ----- SSE validation tests (Task 9) -----

test('flattenRoutes rejects sse + Component', () => {
  expect(() =>
    flattenRoutes([{ path: '/x', sse: () => new ReadableStream(), Component: C }] as Route[]),
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
    flattenRoutes([{ path: '/x', sse: () => new ReadableStream(), middleware: [] }] as Route[]),
  ).not.toThrow()
})

// ----- WS validation tests (Task 10) -----

test('flattenRoutes rejects websocket + Component', () => {
  expect(() =>
    flattenRoutes([{ path: '/x', websocket: async () => ({}), Component: C }] as Route[]),
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
    flattenRoutes([{ path: '/x', websocket: async () => ({}), middleware: [] }] as Route[]),
  ).not.toThrow()
})

// ----- Sub-project J `native: true` validation tests -----

function NamedPage() {
  return null
}

test('flattenRoutes accepts native: true + Component (NamedPage)', () => {
  const flat = flattenRoutes([{ path: '/', Component: NamedPage, native: true }] as Route[])
  expect(flat.length).toBe(1)
  expect(flat[0]!.nativeTemplate).toBe('NamedPage')
})

test('flattenRoutes accepts native: true + Component + loader', () => {
  const flat = flattenRoutes([
    { path: '/', Component: NamedPage, native: true, loader: async () => ({ x: 1 }) },
  ] as Route[])
  expect(flat[0]!.nativeTemplate).toBe('NamedPage')
})

test('flattenRoutes accepts native: true + middleware', () => {
  const flat = flattenRoutes([
    { path: '/', Component: NamedPage, native: true, middleware: [async (_, next) => next()] },
  ] as Route[])
  expect(flat[0]!.nativeTemplate).toBe('NamedPage')
})

test('flattenRoutes rejects native: true without Component', () => {
  expect(() => flattenRoutes([{ path: '/x', native: true } as Route])).toThrow(
    /'native: true' requires 'Component'/,
  )
})

test('flattenRoutes rejects native: true with anonymous Component', () => {
  const anon = (
    () => () =>
      null
  )() as unknown
  expect(() =>
    flattenRoutes([{ path: '/x', Component: anon as never, native: true } as Route]),
  ).toThrow(/must be a named function/)
})

test('flattenRoutes rejects native: true + sse', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', Component: NamedPage, native: true, sse: () => new ReadableStream() } as Route,
    ]),
  ).toThrow(/cannot coexist with 'sse'/)
})

function NamedLeaf() {
  return null
}

test('flattenRoutes accepts native: true + children when the whole subtree is native', () => {
  const flat = flattenRoutes([
    {
      path: '',
      Component: NamedPage,
      native: true,
      children: [{ path: 'y', Component: NamedLeaf, native: true }],
    } as Route,
  ])
  expect(flat).toHaveLength(1)
  expect(flat[0]!.fullPath).toBe('/y')
  // chain is parent → leaf, both native; nativeTemplate is the LEAF's name.
  expect(flat[0]!.chain.map((c) => c.Component?.name)).toEqual(['NamedPage', 'NamedLeaf'])
  expect(flat[0]!.nativeTemplate).toBe('NamedLeaf')
})

test('flattenRoutes accepts a deep native subtree (layout → mid → leaf, all native)', () => {
  function NamedMid() {
    return null
  }
  const flat = flattenRoutes([
    {
      path: '',
      Component: NamedPage,
      native: true,
      children: [
        {
          path: 'a',
          Component: NamedMid,
          native: true,
          children: [{ path: 'b', Component: NamedLeaf, native: true }],
        },
      ],
    } as Route,
  ])
  expect(flat).toHaveLength(1)
  expect(flat[0]!.chain.map((c) => c.Component?.name)).toEqual([
    'NamedPage',
    'NamedMid',
    'NamedLeaf',
  ])
  expect(flat[0]!.nativeTemplate).toBe('NamedLeaf')
})

test('flattenRoutes rejects a native parent with a non-native child (mixed chain)', () => {
  expect(() =>
    flattenRoutes([
      {
        path: '',
        Component: NamedPage,
        native: true,
        children: [{ path: 'y', Component: NamedLeaf }],
      } as Route,
    ]),
  ).toThrow(/cannot mix native and non-native/)
})

test('flattenRoutes rejects a non-native parent with a native child (mixed chain)', () => {
  expect(() =>
    flattenRoutes([
      {
        path: '',
        Component: NamedPage,
        children: [{ path: 'y', Component: NamedLeaf, native: true }],
      } as Route,
    ]),
  ).toThrow(/cannot mix native and non-native/)
})

test('flattenRoutes rejects native: true + cache (deferred)', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', Component: NamedPage, native: true, cache: { ttl_seconds: 60 } } as Route,
    ]),
  ).toThrow(/cannot coexist with 'cache'/)
})
