import { test, expect } from 'bun:test'
import {
  flattenRoutes,
  joinPath,
  notFound,
  redirect,
  runNativeChainLoaders,
  type Route,
} from './routes.ts'
import { defineStore } from './store/define-store.ts'
import { signal } from './store/signal.ts'
import { runInStoreContext } from './store/server-context.ts'

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

test('flattenRoutes allows native: true + cache (native is the L1 target)', () => {
  // The native+cache guard was removed: native routes are now the primary
  // zero-Bun L1 cache target (two-layer page cache). The cache config flows
  // through to the FlatRoute untouched.
  const flat = flattenRoutes([
    { path: '/x', Component: NamedPage, native: true, cache: { ttl_seconds: 60 } } as Route,
  ])
  expect(flat).toHaveLength(1)
  expect(flat[0]?.cache?.ttl_seconds).toBe(60)
})

// --- catch-all '*' (not-found) flatten -----------------------------------------

test("flattenRoutes: catch-all '*' leaf flagged notFound with parent prefix, kept in array", () => {
  const Layout: any = () => null
  const Intro: any = () => null
  const DocsNF: any = () => null
  const GlobalNF: any = () => null
  const flat = flattenRoutes([
    { path: '/', Component: C },
    {
      path: '/docs',
      Component: Layout,
      children: [
        { path: 'intro', Component: Intro },
        { path: '*', Component: DocsNF },
      ],
    },
    { path: '*', Component: GlobalNF },
  ])
  // / , /docs/intro , docs catch-all , global catch-all = 4 entries, all kept.
  expect(flat).toHaveLength(4)
  const nf = flat.filter((f) => f.notFound)
  expect(nf).toHaveLength(2)
  expect(nf.map((f) => f.notFoundPrefix).sort()).toEqual(['', '/docs'])
  // Catch-all fullPath must NOT be a matchit pattern that matches real traffic.
  for (const f of nf) {
    expect(f.fullPath).not.toContain('*')
  }
  // route_id integrity: stable contiguous array (no removal/reindex).
  expect(flat.filter((f) => !f.notFound)).toHaveLength(2)
})

test("flattenRoutes: root catch-all gets prefix '' ", () => {
  const GlobalNF: any = () => null
  const flat = flattenRoutes([
    { path: '/', Component: C },
    { path: '*', Component: GlobalNF },
  ])
  const nf = flat.find((f) => f.notFound)
  expect(nf).toBeDefined()
  expect(nf?.notFoundPrefix).toBe('')
})

test("flattenRoutes: catch-all '*' with children throws (must be a leaf)", () => {
  const X: any = () => null
  const Y: any = () => null
  expect(() =>
    flattenRoutes([{ path: '*', Component: X, children: [{ path: 'y', Component: Y }] }]),
  ).toThrow(/leaf/)
})

test("flattenRoutes: catch-all '*' with index throws (must be a leaf)", () => {
  const X: any = () => null
  expect(() => flattenRoutes([{ path: '*', index: true, Component: X } as Route])).toThrow()
})

test('flattenRoutes: two catch-alls under the same prefix throw', () => {
  const A: any = () => null
  const B: any = () => null
  expect(() =>
    flattenRoutes([
      { path: '*', Component: A },
      { path: '*', Component: B },
    ]),
  ).toThrow(/duplicate|one catch-all/i)
})

test('flattenRoutes: catch-alls under different prefixes are both allowed', () => {
  const Layout: any = () => null
  const DocsNF: any = () => null
  const GlobalNF: any = () => null
  const flat = flattenRoutes([
    { path: '/docs', Component: Layout, children: [{ path: '*', Component: DocsNF }] },
    { path: '*', Component: GlobalNF },
  ])
  expect(flat.filter((f) => f.notFound)).toHaveLength(2)
})

// --- T3: native <Outlet> chain-loader merge (runNativeChainLoaders) -----------

const NLC_CTX = {
  params: {} as Record<string, string>,
  path: '/x',
  req: {} as never,
}

test('runNativeChainLoaders: two-level chain merges, child keys win', async () => {
  const chain: Route[] = [
    { path: '', Component: C, loader: async () => ({ a: 1, shared: 'p' }) } as Route,
    { path: 'leaf', Component: C, loader: async () => ({ b: 2, shared: 'c' }) } as Route,
  ]
  const res = await runNativeChainLoaders(chain, NLC_CTX)
  expect(res).toEqual({ data: { a: 1, b: 2, shared: 'c' } })
})

test('runNativeChainLoaders: parent verdict short-circuits, leaf loader NOT called', async () => {
  let leafCalled = false
  const chain: Route[] = [
    { path: '', Component: C, loader: async () => notFound({ msg: 'gone' }) } as Route,
    {
      path: 'leaf',
      Component: C,
      loader: async () => {
        leafCalled = true
        return { b: 2 }
      },
    } as Route,
  ]
  const res = await runNativeChainLoaders(chain, NLC_CTX)
  expect(leafCalled).toBe(false)
  expect('verdict' in res).toBe(true)
  if ('verdict' in res) {
    expect(res.verdict.status).toBe(404)
    expect(res.verdict.render).toBe(true)
    expect(res.verdict.data).toEqual({ msg: 'gone' })
  }
})

test('runNativeChainLoaders: parent redirect verdict short-circuits', async () => {
  const chain: Route[] = [
    { path: '', Component: C, loader: async () => redirect('/login', 302) } as Route,
    { path: 'leaf', Component: C, loader: async () => ({ b: 2 }) } as Route,
  ]
  const res = await runNativeChainLoaders(chain, NLC_CTX)
  expect('verdict' in res).toBe(true)
  if ('verdict' in res) {
    expect(res.verdict.status).toBe(302)
    expect(res.verdict.render).toBe(false)
    expect(res.verdict.headers).toEqual({ Location: '/login' })
  }
})

test('runNativeChainLoaders: chain.length === 1 behaves as leaf-only (no regression)', async () => {
  const chain: Route[] = [
    { path: 'x', Component: C, loader: async () => ({ only: 'leaf' }) } as Route,
  ]
  const res = await runNativeChainLoaders(chain, NLC_CTX)
  expect(res).toEqual({ data: { only: 'leaf' } })
})

test('runNativeChainLoaders: nodes without a loader are skipped', async () => {
  const chain: Route[] = [
    { path: '', Component: C } as Route, // no loader
    { path: 'mid', Component: C, loader: async () => ({ a: 1 }) } as Route,
    { path: 'leaf', Component: C } as Route, // no loader
  ]
  const res = await runNativeChainLoaders(chain, NLC_CTX)
  expect(res).toEqual({ data: { a: 1 } })
})

test('runNativeChainLoaders: empty chain → empty merged object', async () => {
  const res = await runNativeChainLoaders([], NLC_CTX)
  expect(res).toEqual({ data: {} })
})

test('runNativeChainLoaders: loaders share ONE store context (parent write → child read)', async () => {
  if (typeof (globalThis as Record<string, unknown>).window !== 'undefined') {
    ;(globalThis as Record<string, unknown>).window = undefined
  }
  const store = defineStore('t3-shared', () => {
    const token = signal<string>('')
    return { token }
  })
  const chain: Route[] = [
    {
      path: '',
      Component: C,
      loader: async () => {
        store.token.set('parent-wrote')
        return { a: 1 }
      },
    } as Route,
    {
      path: 'leaf',
      Component: C,
      loader: async () => ({ seen: store.token() }),
    } as Route,
  ]
  // Caller (the native render site) wraps the whole loop in ONE runInStoreContext.
  const res = await runInStoreContext(() => runNativeChainLoaders(chain, NLC_CTX))
  expect(res).toEqual({ data: { a: 1, seen: 'parent-wrote' } })
})
