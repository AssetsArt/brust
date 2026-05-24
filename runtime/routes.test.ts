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
