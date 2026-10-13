// C3 (M3-F): `components[id].stores` on a hand-built compile map (IR JSON objects, no bundling).
import { expect, test } from 'bun:test'
import type { Compiled, ComponentIR } from '../src/build/compile'
import { storesOf, writeManifest } from '../src/build/manifest'

type Use = NonNullable<ComponentIR['stores']>[number]
const use = (handle: string, module: string | null): Use => ({
  handle,
  resolved: module === null ? null : { name: handle, module },
})
const child = (id: string, tier: unknown = 'Native') => ({ name: id, id, path: `./${id}`, tier })

function comp(id: string, stores: Use[], children: ReturnType<typeof child>[] = [], tier: unknown = 'Native'): Compiled {
  const ir: ComponentIR = {
    id,
    source: `${id}.tsx`,
    tier,
    jobs: [],
    instances: [],
    use_id_slots: 0,
    uses_outlet: false,
    needs_worker: false,
    template: [],
    children,
    stores,
  }
  return { id, file: `/app/${id}.tsx`, ir, jinja: '' }
}

function app(): Map<string, Compiled> {
  const reactTier = { React: { reason: 'r', client_only: false } }
  return new Map([
    ['P', comp('P', [use('cart', 'stores/cart.ts')], [child('N'), child('I', reactTier)])],
    ['N', comp('N', [use('ui', 'stores/ui.ts'), use('cart', 'stores/cart.ts'), use('lost', null)])],
    ['I', comp('I', [use('team', 'stores/team.ts')], [], reactTier)],
    ['Q', comp('Q', [])],
  ])
}

test('storesOf: own + every descendant through ir.children, sorted unique; unresolved uses contribute nothing', () => {
  const compiled = app()
  expect(storesOf(compiled, 'P')).toEqual(['stores/cart.ts', 'stores/team.ts', 'stores/ui.ts'])
  expect(storesOf(compiled, 'N')).toEqual(['stores/cart.ts', 'stores/ui.ts'])
  expect(storesOf(compiled, 'Q')).toEqual([])
})

test('storesOf: a missing `stores` field and an uncompiled child (id null or unknown) contribute nothing', () => {
  const compiled = app()
  delete compiled.get('Q')!.ir.stores
  compiled.get('Q')!.ir.children = [{ name: 'X', id: null, path: null, tier: 'Native' }, child('gone')]
  expect(storesOf(compiled, 'Q')).toEqual([])
})

test('storesOf: cycles terminate', () => {
  const compiled = app()
  compiled.get('N')!.ir.children = [child('P')]
  expect(storesOf(compiled, 'N')).toEqual(['stores/cart.ts', 'stores/team.ts', 'stores/ui.ts'])
  expect(storesOf(compiled, 'P')).toEqual(['stores/cart.ts', 'stores/team.ts', 'stores/ui.ts'])
})

test('writeManifest puts `stores` on every component record', () => {
  const m = writeManifest({ leaves: [], routeComponent: new Map(), compiled: app(), runtime: { core: 'client/runtime.js', features: { island: 'client/rt-island.js' } }, chunks: new Map() })
  expect(Object.fromEntries(Object.entries(m.components).map(([id, c]) => [id, c.stores]))).toEqual({
    I: ['stores/team.ts'],
    N: ['stores/cart.ts', 'stores/ui.ts'],
    P: ['stores/cart.ts', 'stores/team.ts', 'stores/ui.ts'],
    Q: [],
  })
  // After `use_id_slots` in the record (key order is the JSON order).
  const keys = Object.keys(m.components.P!)
  expect(keys.indexOf('stores')).toBe(keys.indexOf('use_id_slots') + 1)
})

test('writeManifest refuses a component whose runtime feature the build did not ship', () => {
  const opts = { leaves: [], routeComponent: new Map(), compiled: app(), chunks: new Map() }
  expect(() => writeManifest({ ...opts, runtime: { core: 'client/runtime.js', features: {} } })).toThrow(expect.objectContaining({ rule: 'runtime-feature-missing', message: expect.stringContaining('I: needs the client runtime feature island') }))
})
