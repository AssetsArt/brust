import { expect, test } from 'bun:test'
import { getServerInstance } from '../src/store/server-context'
import { defineRoutes, flattenRoutes, httpError, notFound, redirect } from '../src/routes'
import { type JobsModule, makeDispatch, makeHandlers, type ManifestLike } from '../src/worker'

const C = () => null
const ctx = (routeId = 'r1') => ({
  routeId,
  params: { id: '7' },
  path: '/items/7',
  req: { method: 'GET', url: '/items/7', headers: {}, cookies: {}, search: {} },
})
// biome-ignore lint/suspicious/noExplicitAny: loader fixtures
const leaves = (child: any, parent?: any) =>
  flattenRoutes(defineRoutes([{ Component: C, loader: parent, children: [{ path: '/items/{id}', Component: C, loader: child }] }])).leaves

function rec(name: string, initial = 0) {
  return getServerInstance(name, () => {
    let value = initial
    return {
      instance: {},
      get value() {
        return value
      },
      set value(v: number) {
        value = v
      },
      handle: {
        serialize: () => ({ value }),
        hydrate(s: Record<string, unknown>) {
          value = s.value as number
        },
      },
    } as never
  }) as unknown as { value: number }
}
/** A handle whose call touches its store (what a real `defineStore` handle does). */
function fakeHandle(name: string) {
  const fn = (() => rec(name)) as unknown as Record<string, unknown>
  Object.defineProperty(fn, 'name', { value: name })
  for (const k of ['subscribe', 'snapshot', 'serialize', 'hydrate']) fn[k] = () => undefined
  return fn
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a loader write lands in LoaderResponse.store', async () => {
  const h = makeHandlers({
    leaves: leaves(() => {
      rec('cart', 0).value = 3
      return { a: 1 }
    }),
    jobs: {},
  })
  expect(await h.loader(ctx())).toEqual({ ok: true, data: { a: 1 }, store: { cart: { value: 3 } } })
})

test('no store touched -> no store key, byte-identical JSON', async () => {
  const h = makeHandlers({ leaves: leaves(async () => ({ b: 2 }), async () => ({ a: 1 })), jobs: {} })
  const r = await h.loader(ctx())
  expect('store' in r).toBe(false)
  expect(JSON.stringify(r)).toBe('{"ok":true,"data":{"a":1,"b":2}}')
})

test('notFound carries the store; redirect/httpError/error do not', async () => {
  const touch = () => {
    rec('cart').value = 5
  }
  const nf = makeHandlers({
    leaves: leaves(() => {
      touch()
      return notFound({ why: 'x' })
    }),
    jobs: {},
  })
  expect(await nf.loader(ctx())).toEqual({ verdict: 'notFound', data: { why: 'x' }, store: { cart: { value: 5 } } })
  const rd = makeHandlers({
    leaves: leaves(() => {
      touch()
      return redirect('/l', 303)
    }),
    jobs: {},
  })
  expect(await rd.loader(ctx())).toEqual({ verdict: 'redirect', location: '/l', status: 303 })
  const he = makeHandlers({
    leaves: leaves(() => {
      touch()
      throw httpError(403, 'no')
    }),
    jobs: {},
  })
  expect(await he.loader(ctx())).toEqual({ verdict: 'httpError', status: 403, body: 'no', contentType: 'text/plain; charset=utf-8' })
  const er = makeHandlers({
    leaves: leaves(() => {
      touch()
      throw new Error('boom')
    }),
    jobs: {},
  })
  expect(await er.loader(ctx())).toEqual({ error: 'Error: boom' })
})

test('two interleaved loader calls snapshot their own writes', async () => {
  const h = makeHandlers({
    leaves: leaves(async ({ req }: { req: { search: Record<string, string> } }) => {
      const id = Number(req.search.id)
      await sleep(id === 1 ? 20 : 1)
      rec('s').value = id
      await sleep(id === 1 ? 20 : 1)
      return { id }
    }),
    jobs: {},
  })
  const mk = (id: string) => ({ ...ctx(), req: { ...ctx().req, search: { id } } })
  const [a, b] = await Promise.all([h.loader(mk('1')), h.loader(mk('2'))])
  expect((a as { store: unknown }).store).toEqual({ s: { value: 1 } })
  expect((b as { store: unknown }).store).toEqual({ s: { value: 2 } })
})

test('manifest stores are touched before the chain', async () => {
  const manifest: ManifestLike = {
    routes: [{ id: 'r1', chain: ['p'] }],
    components: {
      p: { jobs: [{ id: 'j', kind: 'ssr', target: 'z' }], children: [{ id: 'k' }], stores: ['s.ts'] },
      k: { jobs: [], stores: ['t.ts'] },
      z: { jobs: [], stores: ['u.ts'] },
    },
  }
  const stores = { 's.ts': { A: fakeHandle('a') }, 't.ts': { B: fakeHandle('b') }, 'u.ts': { C: fakeHandle('c') } }
  const h = makeHandlers({ leaves: leaves(() => ({})), jobs: {}, manifest, stores })
  expect(await h.loader(ctx())).toEqual({
    ok: true,
    data: {},
    store: { a: { value: 0 }, b: { value: 0 }, c: { value: 0 } },
  })
})

test('ssr job runs in a scope seeded from inputs.__store, and props lose __store', async () => {
  let seen: unknown
  let value = -1
  const jobs: JobsModule = {
    t: {
      ssr: (p) => {
        seen = p
        value = rec('cart').value
        return ''
      },
    },
  }
  const h = makeHandlers({ leaves: [], jobs })
  const r = await h.jobs({
    jobs: [{ id: 'c/j0', componentId: 'c', kind: 'ssr', target: 't', inputs: { team: [], __store: { cart: { value: 7 } } } }],
  })
  expect(r.results).toEqual([{ id: 'c/j0', value: '' }])
  expect(value).toBe(7)
  expect('__store' in (seen as object)).toBe(false)
  expect(seen).toEqual({ team: [] })
})

test('precompute jobs run outside any scope', async () => {
  const jobs: JobsModule = { c: { precompute: () => rec('cart') } }
  const h = makeHandlers({ leaves: [], jobs })
  const r = await h.jobs({ jobs: [{ id: 'c/j0', componentId: 'c', kind: 'precompute', inputs: {} }] })
  expect((r.results[0] as { error: string }).error).toMatch(/outside a request scope/)
})

test('an ssr job never sees the loader scope (planned path)', async () => {
  let value = -1
  const jobs: JobsModule = {
    t: {
      ssr: () => {
        value = rec('cart').value
        return ''
      },
    },
  }
  const h = makeHandlers({
    leaves: leaves(() => {
      rec('cart', 0).value = 99
      return {}
    }),
    jobs,
  })
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  const plan = () =>
    JSON.stringify({
      jobs: [{ id: 'c/j0', componentId: 'c', kind: 'ssr', target: 't', inputs: { __store: { cart: { value: 4 } } } }],
    })
  const d = makeDispatch(h, view, 1, plan)
  const n = await d('loader', JSON.stringify({ ...ctx(), plan: true }), 0)
  expect(JSON.parse(new TextDecoder().decode(view.subarray(0, n)))).toEqual({
    planned: true,
    results: [{ id: 'c/j0', value: '' }],
  })
  expect(value).toBe(4)
})

// --- S8: real core (defineStore) through the installed resolver ---
const realStore = async () => {
  const core = await import('@brust/core/store')
  return core
}

test('defineStore in a loader -> store snapshot', async () => {
  const { defineStore, signal } = await realStore()
  const cart = defineStore('cart_loader', () => ({ count: signal(0) }))
  const h = makeHandlers({
    leaves: leaves(() => {
      cart.count.set(3)
      return {}
    }),
    jobs: {},
  })
  expect(await h.loader(ctx())).toEqual({ ok: true, data: {}, store: { cart_loader: { count: 3 } } })
})

test('a manifest-touched real store contributes its defaults', async () => {
  const { defineStore, signal } = await realStore()
  const cart = defineStore('cart_default', () => ({ count: signal(5) }))
  const manifest: ManifestLike = {
    routes: [{ id: 'r1', chain: ['p'] }],
    components: { p: { jobs: [], stores: ['s.ts'] } },
  }
  const h = makeHandlers({ leaves: leaves(() => ({})), jobs: {}, manifest, stores: { 's.ts': { cart } } })
  expect(await h.loader(ctx())).toEqual({ ok: true, data: {}, store: { cart_default: { count: 5 } } })
})

test('an ssr job reads the seeded value through the handle', async () => {
  const { defineStore, signal } = await realStore()
  const cart = defineStore('cart_ssr', () => ({ count: signal(0) }))
  let out = ''
  const jobs: JobsModule = {
    t: {
      ssr: () => {
        out = String(cart.count())
        return ''
      },
    },
  }
  const h = makeHandlers({ leaves: [], jobs })
  await h.jobs({ jobs: [{ id: 'c/j0', componentId: 'c', kind: 'ssr', target: 't', inputs: { __store: { cart_ssr: { count: 4 } } } }] })
  expect(out).toBe('4')
})

test('the worker sees ONE store core', async () => {
  const a = await import('@brust/core/store')
  const b = await import('@brust/runtime-dom/store')
  expect(a.defineStore).toBe(b.defineStore)
})

test('store access outside a request scope throws', async () => {
  const { defineStore, signal } = await realStore()
  const cart = defineStore('cart_out', () => ({ count: signal(0) }))
  expect(() => cart.count()).toThrow(/outside a request scope/)
})

test('a loader-less route still snapshots its manifest stores (S7b)', async () => {
  const manifest: ManifestLike = {
    routes: [{ id: 'r1', chain: ['p'] }],
    components: { p: { jobs: [], stores: ['s.ts'] } },
  }
  const h = makeHandlers({ leaves: leaves(undefined), jobs: {}, manifest, stores: { 's.ts': { A: fakeHandle('a') } } })
  expect(await h.loader(ctx())).toEqual({ ok: true, data: {}, store: { a: { value: 0 } } })
})
