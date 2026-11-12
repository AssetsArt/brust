// F533: a loader response's store snapshot names the keys the loader WROTE under the reserved `~w`, so a navigation
// sets exactly those on a live client store. A write equal to the current value still counts; a seed's hydrate (an ssr
// job's `__store`, the loader's built-in navigation seed) never does; no write, no `~w`.
import { expect, test } from 'bun:test'
import { defineStore, signal } from '@brust/runtime-dom/store'
import { NAVIGATION_MODULE } from '../src/store/builtin'
import { collectSnapshot, runInStoreContext } from '../src/store/server-context'
import { defineRoutes, flattenRoutes } from '../src/routes'
import { makeHandlers } from '../src/worker'
import * as serverNavigation from '../src/navigation'

// importing ../src/worker installs the server resolver process-wide (as at worker boot); never lift it here

const page = defineStore('f533_page', () => ({ id: signal('0'), count: signal(0), tags: signal<string[]>([]) }))

test('only the written keys are listed, in write order; untouched keys are state but not written', () => {
  runInStoreContext(() => {
    page.id.set('2')
    page.tags.set(['a'])
    expect(collectSnapshot()).toEqual({ f533_page: { id: '2', count: 0, tags: ['a'], '~w': ['id', 'tags'] } })
  })
})

test('a write equal to the current value is still a write', () => {
  runInStoreContext(() => {
    page.count.set(0)
    expect(collectSnapshot()!.f533_page!['~w']).toEqual(['count'])
  })
})

test('a store only read has no ~w; a write in one scope does not leak into the next', () => {
  runInStoreContext(() => {
    page.id.set('9')
  })
  runInStoreContext(() => {
    expect(page.id()).toBe('0')
    expect(collectSnapshot()).toEqual({ f533_page: { id: '0', count: 0, tags: [] } })
  })
})

test('a seed hydrate marks nothing and its own ~w is not state; a write after it is marked', () => {
  const seed = { f533_page: { id: '5', count: 3, '~w': ['id'] } }
  runInStoreContext(() => {
    expect(page.snapshot()).toEqual({ id: '5', count: 3, tags: [] } as never)
    expect(collectSnapshot()).toEqual({ f533_page: { id: '5', count: 3, tags: [] } })
    page.hydrate({ count: 4 }) // an explicit hydrate is a seed too
    expect(collectSnapshot()!.f533_page!['~w']).toBeUndefined()
    page.count.set(4)
    expect(collectSnapshot()!.f533_page!['~w']).toEqual(['count'])
  }, seed)
})

test("defineStore refuses a member named '~w'", () => {
  const bad = defineStore('f533_bad', () => ({ '~w': signal(0) }))
  expect(() => runInStoreContext(() => bad())).toThrow("store 'f533_bad': '~w' is reserved")
})

test('through the loader: the route loader writes are listed; the built-in navigation seed is not', async () => {
  const C = () => null
  const leaves = flattenRoutes(defineRoutes([{ Component: C, children: [{ path: '/a', Component: C, loader: () => { page.id.set('7'); return {} } }] }])).leaves
  const store = '/stores/page.ts'
  const manifest = { routes: [{ id: leaves[0]!.id, chain: ['x'] }], components: { x: { stores: [NAVIGATION_MODULE, store], children: [], jobs: [] } } }
  const h = makeHandlers({ leaves, jobs: {}, stores: { [NAVIGATION_MODULE]: serverNavigation, [store]: { page } }, manifest: manifest as never })
  const r = (await h.loader({ routeId: leaves[0]!.id, params: {}, path: '/a', req: { method: 'GET', url: '/a?q=1', headers: {}, cookies: {}, search: {} } } as never)) as { store?: Record<string, Record<string, unknown>> }
  expect(r.store!.f533_page).toEqual({ id: '7', count: 0, tags: [], '~w': ['id'] })
  expect(r.store!.navigation!.url).toBe('/a?q=1')
  expect(r.store!.navigation!['~w']).toBeUndefined()
})
