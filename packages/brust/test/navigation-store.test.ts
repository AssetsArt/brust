// F461 (design docs/design/2026-10-25-spa-navigation-design.md §11): the built-in `navigation` store. The server half
// (idle defaults, the loader seeding `url`) and the browser half (the four `brust:nav:*` events set the signals) are
// pinned here; the real thing in Chromium is tests/server/nav-store.chromium.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { __setServerResolver } from '@brust/runtime-dom/store/internal'
import { NAVIGATION_MODULE } from '../src/store/builtin'
import { collectSnapshot, getServerInstance, runInStoreContext } from '../src/store/server-context'
import { defineRoutes, flattenRoutes } from '../src/routes'
import { makeHandlers } from '../src/worker'
import * as serverNavigation from '../src/navigation'

const C = () => null
const req = (url: string) => ({ routeId: 'r1', params: {}, path: url.split('?')[0]!, req: { method: 'GET', url, headers: {}, cookies: {}, search: {} } })
const leaves = flattenRoutes(defineRoutes([{ Component: C, children: [{ path: '/a', Component: C }] }])).leaves

const idle = { state: 'idle', url: '/', to: null, trigger: null, status: null, error: null, id: 0 }

test('on the server a request scope paints idle, and the snapshot lists every key', () => {
  runInStoreContext(() => {
    expect(serverNavigation.navigation.snapshot()).toEqual(idle as never)
    expect(collectSnapshot()).toEqual({ navigation: idle })
  })
})

test('the loader seeds url with the request path + search when a route reads the store, and not otherwise', async () => {
  const comps = (stores: string[]) => ({ x: { stores, children: [], jobs: [] } })
  const manifest = (stores: string[]) => ({ routes: [{ id: 'r1', chain: ['x'] }], components: comps(stores) })
  const table = { [NAVIGATION_MODULE]: serverNavigation }
  const reads = makeHandlers({ leaves, jobs: {}, stores: table, manifest: manifest([NAVIGATION_MODULE]) as never })
  const r = await reads.loader(req('/a?q=1&r=two'))
  expect(r).toEqual({ ok: true, data: {}, store: { navigation: { ...idle, url: '/a?q=1&r=two' } } })
  // Two requests never share the seed.
  const r2 = await reads.loader(req('/a'))
  expect((r2 as unknown as { store: { navigation: { url: string } } }).store.navigation.url).toBe('/a')
  // A route that does not read the store carries no navigation entry.
  const other = makeHandlers({ leaves, jobs: {}, stores: table, manifest: manifest([]) as never })
  expect('store' in (await other.loader(req('/a')))).toBe(false)
})

test('a user loader still sees its own writes next to the seeded navigation store', async () => {
  const withLoader = flattenRoutes(defineRoutes([{ Component: C, children: [{ path: '/a', Component: C, loader: () => ({ n: 1 }) }] }])).leaves
  const h = makeHandlers({
    leaves: withLoader,
    jobs: {},
    stores: { [NAVIGATION_MODULE]: serverNavigation },
    manifest: { routes: [{ id: 'r1', chain: ['x'] }], components: { x: { stores: [NAVIGATION_MODULE], children: [], jobs: [] } } } as never,
  })
  const r = await h.loader(req('/a?z=1'))
  expect(r).toMatchObject({ ok: true, data: { n: 1 }, store: { navigation: { url: '/a?z=1' } } })
})

describe('browser', () => {
  // ---- the browser half: a fake document, no server resolver ----

  type G = { document?: unknown; location?: unknown }
  const g = globalThis as unknown as G
  let saved: { document: unknown; location: unknown }
  let doc: EventTarget & { querySelectorAll(): never[] }
  let nav: typeof serverNavigation.navigation

  beforeAll(async () => {
    saved = { document: g.document, location: g.location }
    __setServerResolver(null)
    delete (globalThis as { [k: symbol]: unknown })[Symbol.for('brust.stores')]
    doc = Object.assign(new EventTarget(), { querySelectorAll: () => [] })
    g.document = doc
    g.location = { pathname: '/start', search: '?s=1', href: 'http://h/start?s=1' }
    // A copy of the module that sees `document`: the query makes it a separate instance.
    const copy = '../src/navigation.ts?browser'
    nav = ((await import(copy)) as typeof serverNavigation).navigation
  })
  afterAll(() => {
    g.document = saved.document
    g.location = saved.location
    delete (globalThis as { [k: symbol]: unknown })[Symbol.for('brust.stores')]
    delete (globalThis as { [k: symbol]: unknown })[Symbol.for('brust.navigation')]
    __setServerResolver(getServerInstance as never)
  })

  const fire = (name: string, detail: object) => doc.dispatchEvent(new CustomEvent(`brust:nav:${name}`, { detail }))
  const snap = () => nav.snapshot() as unknown as Record<string, unknown>

  test('browser: a new tab starts idle on the page it loaded', () => {
    expect(snap()).toEqual({ ...idle, url: '/start?s=1' })
  })

  test('browser: load sets loading, to, trigger and id and clears error; success sets idle and the new url', () => {
    fire('load', { id: 3, url: 'http://h/next?x=1#frag', from: 'http://h/start?s=1', trigger: 'link' })
    expect(snap()).toEqual({ ...idle, state: 'loading', url: '/start?s=1', to: '/next?x=1', trigger: 'link', id: 3 })
    fire('success', { id: 3, url: 'http://h/next?x=1#frag', from: 'http://h/start?s=1', trigger: 'link', status: 200 })
    expect(snap()).toEqual({ ...idle, url: '/next?x=1', trigger: 'link', status: 200, id: 3 })
  })

  test('browser: a swapped error page updates url; a failed swap keeps the page and carries the message', () => {
    fire('load', { id: 4, url: 'http://h/gone', from: 'http://h/next?x=1', trigger: 'navigate' })
    fire('error', { id: 4, url: 'http://h/gone', from: 'http://h/next?x=1', trigger: 'navigate', status: 404, error: undefined, swapped: true })
    expect(snap()).toMatchObject({ state: 'idle', url: '/gone', to: null, status: 404, error: 'HTTP 404', trigger: 'navigate', id: 4 })
    fire('load', { id: 5, url: 'http://h/x', from: 'http://h/gone', trigger: 'popstate' })
    expect(snap().error).toBeNull()
    fire('error', { id: 5, url: 'http://h/x', from: 'http://h/gone', trigger: 'popstate', status: undefined, error: new TypeError('Failed to fetch'), swapped: false })
    expect(snap()).toMatchObject({ state: 'idle', url: '/gone', to: null, status: null, error: 'Failed to fetch', trigger: 'popstate', id: 5 })
  })

  test('browser: a second copy of the module (another chunk) does not subscribe again', async () => {
    const added: string[] = []
    const orig = doc.addEventListener.bind(doc)
    doc.addEventListener = ((t: string, ...rest: unknown[]) => {
      added.push(t)
      return (orig as (...a: unknown[]) => void)(t, ...rest)
    }) as typeof doc.addEventListener
    const again = '../src/navigation.ts?again'
    await import(again)
    doc.addEventListener = orig
    expect(added).toEqual([])
  })

  test('dev: another defineStore(\'navigation\') that made the record in use is warned about', async () => {
    const reg = globalThis as unknown as { [k: symbol]: unknown; __BRUST_DEV__?: boolean }
    delete reg[Symbol.for('brust.stores')]
    delete reg[Symbol.for('brust.navigation')]
    const { defineStore, signal } = await import('@brust/runtime-dom/store')
    const mine = defineStore('navigation', () => ({ open: signal(false) }))
    mine() // the user's store resolves first and owns the record
    const warned: string[] = []
    const warn = console.warn
    console.warn = (m: string) => void warned.push(m)
    reg.__BRUST_DEV__ = true
    try {
      const spec = '../src/navigation.ts?dev-warn'
      await import(spec)
    } finally {
      console.warn = warn
      delete reg.__BRUST_DEV__
    }
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain("'navigation' is reserved")
  })

  test('dev: its own record, and production with a foreign one, stay quiet', async () => {
    const reg = globalThis as unknown as { [k: symbol]: unknown; __BRUST_DEV__?: boolean }
    delete reg[Symbol.for('brust.stores')]
    delete reg[Symbol.for('brust.navigation')]
    const warned: string[] = []
    const warn = console.warn
    console.warn = (m: string) => void warned.push(m)
    reg.__BRUST_DEV__ = true
    try {
      const spec = '../src/navigation.ts?dev-quiet'
      await import(spec)
    } finally {
      console.warn = warn
      delete reg.__BRUST_DEV__
    }
    expect(warned).toEqual([])
  })
})
