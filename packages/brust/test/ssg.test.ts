// `brust build --target static` (gaps round L9): the pure planner, the `ssg` route field, the
// request a loader sees while rendering (R9.5) and the refusals checked before any write (R9.3/R9.4).
import { expect, test } from 'bun:test'
import { BuildError } from '../src/build/errors'
import { fileFor, NOT_FOUND_PATH, planStatic } from '../src/build/ssg'
import { prepareStatic, redirectSource } from '../src/build/static'
import { type SsgRecord, ssgRequest } from '../src/handlers'
import { BrustRouteError, flattenRoutes, type Route, validateRoutes } from '../src/routes'

const C = () => null
const leaves = (routes: Route[]) => flattenRoutes(routes).leaves
const noReads = () => []
const rule = async (f: () => unknown): Promise<string> => {
  try {
    await f()
  } catch (e) {
    if (e instanceof BuildError) return `${e.rule}: ${e.message}`
    throw e
  }
  throw new Error('expected a BuildError')
}

test('file names: / is index.html, pretty URLs, decoded segments', () => {
  expect(['/', '/docs', '/docs/x', '/p/100%25', '/p/%E0%B9%84%E0%B8%97%E0%B8%A2'].map((p) => fileFor(p))).toEqual(['index.html', 'docs.html', 'docs/x.html', 'p/100%.html', 'p/ไทย.html'])
})

test('static and dynamic routes are planned; values are encoded in the request and decoded in the file', () => {
  const ls = leaves([
    { path: '/', Component: C },
    { path: '/p/{name}', Component: C, ssg: { params: () => [] } },
    { path: '/off/{id}', Component: C, ssg: false },
    { path: '/gone', Component: C, ssg: false },
    { path: '*', Component: C },
  ])
  const plan = planStatic(ls, new Map([['r1', [{ name: 'pika' }, { name: '100%' }, { name: 'ไทย' }]]]))
  expect(plan.pages.map((p) => [p.path, p.file, p.expect])).toEqual([
    ['/', 'index.html', 200],
    ['/p/pika', 'p/pika.html', 200],
    ['/p/100%25', 'p/100%.html', 200],
    ['/p/%E0%B9%84%E0%B8%97%E0%B8%A2', 'p/ไทย.html', 200],
    [NOT_FOUND_PATH, '404.html', 404],
  ])
  expect(plan.skipped).toEqual([
    { routeId: 'r2', pattern: '/off/{id}' },
    { routeId: 'r3', pattern: '/gone' },
  ])
  expect(plan.defaultNotFound).toBe(false)
  expect(planStatic(leaves([{ path: '/', Component: C }]), new Map()).defaultNotFound).toBe(true)
})

test('a {*rest} value may hold /, a {name} value may not; bad values and duplicate files are errors', async () => {
  const rest = leaves([{ path: '/d/{*slug}', Component: C, ssg: { params: () => [] } }])
  expect(planStatic(rest, new Map([['r0', [{ slug: 'a/b' }]]])).pages[0]).toMatchObject({ path: '/d/a/b', file: 'd/a/b.html' })
  const one = leaves([{ path: '/p/{name}', Component: C, ssg: { params: () => [] } }])
  const plan = (recs: unknown) => () => planStatic(one, new Map([['r0', recs]]))
  expect(await rule(plan([{}]))).toStartWith('ssg-params: route r0 (/p/{name}) ssg.params()[0].name is missing')
  expect(await rule(plan([{ name: '' }]))).toStartWith('ssg-params: route r0 (/p/{name}) ssg.params()[0].name is empty')
  expect(await rule(plan([{ name: 'a/b' }]))).toContain("contains '/'")
  expect(await rule(plan([{ name: '..' }]))).toContain("'..' segment")
  expect(await rule(() => planStatic(rest, new Map([['r0', [{ slug: 'a//b' }]]])))).toContain('empty')
  expect(await rule(plan([{ name: 'x' }, { name: 'x' }]))).toContain('both write p/x.html')
  expect(await rule(plan({ name: 'x' }))).toContain('must return an array')
  expect(await rule(plan([7]))).toContain('is not a record')
})

test('R9.3: a dynamic route without params is ssg-params-missing; ssg: false opts out', async () => {
  const ls = leaves([{ path: '/p/{name}/{id}', Component: C }])
  expect(await rule(() => planStatic(ls, new Map()))).toBe(
    "ssg-params-missing: route r0 (/p/{name}/{id}) is dynamic: add ssg: { params: () => [{ name: '…', id: '…' }] } or ssg: false",
  )
  expect(planStatic(leaves([{ path: '/p/{name}', Component: C, ssg: false }]), new Map()).pages).toEqual([])
})

test('R9.2: the ssg field is validated (false or { params: fn }, leaves only)', () => {
  const bad = (r: Route, msg: string) => expect(() => validateRoutes([r])).toThrow(new BrustRouteError(msg))
  bad({ path: '/', Component: C, ssg: true as never }, 'route /: ssg must be false or { params }')
  bad({ path: '/', Component: C, ssg: { params: [] as never } }, 'route /: ssg.params must be a function')
  bad({ path: '/', Component: C, ssg: { paths: () => [] } as never }, 'route /: unknown ssg field ssg.paths (allowed: params)')
  bad({ path: '/a', ssg: false, children: [{ path: 'b', Component: C }] }, 'route /a: ssg on a layout route is not supported (put it on each leaf)')
  expect(() => validateRoutes([{ path: '/', Component: C, ssg: false }, { path: '/p/{x}', Component: C, ssg: { params: () => [{ x: '1' }] } }])).not.toThrow()
})

test('R9.4: [actions] and a cache key that reads the request refuse the build; params() is awaited', async () => {
  const ls = leaves([{ path: '/', Component: C }])
  expect(await rule(() => prepareStatic(ls, true, noReads, () => {}))).toStartWith('ssg-actions: [actions] is configured')
  const cached = leaves([{ path: '/', Component: C, cache: { ttl_seconds: 60, prefix: 'cookie(currency)' } }])
  const reads = (e: string) => (e === 'cookie(currency)' ? ['cookie(currency)'] : [])
  expect(await rule(() => prepareStatic(cached, false, reads, () => {}))).toStartWith('ssg-varies: route r0 (/) cache.prefix reads cookie(currency)')
  const bypass = leaves([{ path: '/', Component: C, cache: { ttl_seconds: 60, bypass: 'header(x-preview)' } }])
  expect(await rule(() => prepareStatic(bypass, false, () => ['header(x-preview)'], () => {}))).toContain('cache.bypass reads header(x-preview)')
  // ssg: false routes are not rendered, so their cache key does not matter
  const off = leaves([{ path: '/', Component: C, ssg: false, cache: { ttl_seconds: 60, prefix: 'cookie(c)' } }])
  expect((await prepareStatic(off, false, () => ['cookie(c)'], () => {})).pages).toEqual([])
  const log: string[] = []
  const dyn = leaves([
    { path: '/', Component: C, cache: { ttl_seconds: 60, prefix: 'param(x)' } },
    { path: '/p/{n}', Component: C, ssg: { params: async () => [{ n: '1' }] } },
  ])
  expect((await prepareStatic(dyn, false, noReads, (s) => log.push(s))).pages.map((p) => p.path)).toEqual(['/', '/p/1'])
  expect(log).toEqual(['[brust] static: cache.ttl_seconds does not apply to static files (ignored)'])
  const throws = leaves([{ path: '/p/{n}', Component: C, ssg: { params: () => Promise.reject(new Error('db down')) } }])
  expect(await rule(() => prepareStatic(throws, false, noReads, () => {}))).toBe('ssg-params: route r0 (/p/{n}) ssg.params() threw: db down')
})

test('R9.5: the loader sees an empty request, and every read is recorded', () => {
  const recs: SsgRecord[] = []
  const req = ssgRequest({ method: 'GET', url: 'http://x/a', headers: { host: 'x' }, cookies: {}, search: {} }, 'r1', '/a', (r) => recs.push(r))
  expect(req.method).toBe('GET')
  expect(req.url).toBe('http://x/a')
  expect(req.headers.host).toBeUndefined()
  expect('theme' in req.cookies).toBe(false)
  expect(Object.keys(req.search)).toEqual([])
  expect(recs).toEqual([
    { kind: 'read', routeId: 'r1', path: '/a', field: 'headers', key: 'host' },
    { kind: 'read', routeId: 'r1', path: '/a', field: 'cookies', key: 'theme' },
    { kind: 'read', routeId: 'r1', path: '/a', field: 'search', key: '*' },
  ])
})

test('review N1: a stray % or an unencodable value is ssg-param-encoding naming the route, never a URIError', async () => {
  expect(await rule(() => planStatic(leaves([{ path: '/sale/50%off', Component: C }]), new Map()))).toBe(
    'ssg-param-encoding: route r0 (/sale/50%off): path segment "50%off" is not valid percent-encoding (write a literal % as %25)',
  )
  const one = leaves([{ path: '/p/{name}', Component: C, ssg: { params: () => [] } }])
  expect(await rule(() => planStatic(one, new Map([['r0', [{ name: 'a\uD800' }]]])))).toBe(
    'ssg-param-encoding: route r0 (/p/{name}) ssg.params()[0].name = "a\\ud800" is not encodable (a lone UTF-16 surrogate)',
  )
})

test('review N2: paths that differ only by case are ssg-path-collision', async () => {
  const ls = leaves([
    { path: '/About', Component: C },
    { path: '/p/{name}', Component: C, ssg: { params: () => [] } },
  ])
  // different directories: no collision
  expect(planStatic(ls, new Map([['r1', [{ name: 'about' }]]])).pages.map((p) => p.file)).toEqual(['About.html', 'p/about.html'])
  const two = leaves([
    { path: '/About', Component: C },
    { path: '/{name}', Component: C, ssg: { params: () => [] } },
  ])
  expect(await rule(() => planStatic(two, new Map([['r1', [{ name: 'about' }]]])))).toBe(
    'ssg-path-collision: /About (route r0, About.html) and /about (route r1, about.html) differ only by case: on a case-insensitive file system one file overwrites the other',
  )
})

test('review N4: a _redirects source is the decoded path; only whitespace, controls and % are escaped', () => {
  expect(redirectSource('/old')).toBe('/old')
  expect(redirectSource(`/${encodeURIComponent('เก่า')}`)).toBe('/เก่า')
  expect(redirectSource('/เก่า')).toBe('/เก่า')
  expect(redirectSource('/a%20b/100%25')).toBe('/a%20b/100%25')
  expect(redirectSource('/bad%zz')).toBe('/bad%25zz')
})
