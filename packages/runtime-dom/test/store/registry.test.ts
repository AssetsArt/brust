import { afterEach, expect, test } from 'bun:test'
import {
  type StoreInstanceRecord,
  __setServerResolver,
  _resetStores,
  applyStoreSnapshot,
  resolveRecord,
} from '../../src/store/registry'
import { signal } from '../../src/signal'

const STORES = Symbol.for('brust.stores')
const rec = (instance: object = {}): StoreInstanceRecord => ({ instance, subs: new Set(), version: { n: 0 }, snap: null })

function tag(name: string, json: string) {
  const el = document.createElement('script')
  el.setAttribute('type', 'application/json')
  el.setAttribute('data-brust-store', name)
  el.textContent = json
  document.head.appendChild(el)
}

afterEach(() => {
  __setServerResolver(null)
  _resetStores()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

test("first access creates the record once in globalThis[Symbol.for('brust.stores')]", () => {
  let created = 0
  const create = () => { created++; return rec() }
  const a = resolveRecord('s', create, () => {})
  const b = resolveRecord('s', create, () => {})
  expect(a).toBe(b)
  expect(created).toBe(1)
  expect((globalThis as Record<symbol, Record<string, unknown>>)[STORES]!.s).toBe(a)
})

test('first access seeds from script[data-brust-store=NAME]', () => {
  tag('other', '{"x":9}')
  tag('profile', '{"handle":"ash"}')
  const seeds: Record<string, unknown>[] = []
  const seed = (_r: StoreInstanceRecord, s: Record<string, unknown>) => { seeds.push(s) }
  resolveRecord('profile', () => rec(), seed)
  expect(seeds).toEqual([{ handle: 'ash' }])
  resolveRecord('profile', () => rec(), seed) // second access does not re-seed
  expect(seeds.length).toBe(1)
})

test('bad snapshot JSON seeds nothing and warns', () => {
  tag('bad', '{nope')
  const warn = console.warn
  const warned: unknown[][] = []
  console.warn = (...a: unknown[]) => { warned.push(a) }
  const seeds: Record<string, unknown>[] = []
  try {
    resolveRecord('bad', () => rec(), (_r, s) => { seeds.push(s) })
  } finally {
    console.warn = warn
  }
  expect(seeds.every((s) => Object.keys(s).length === 0)).toBe(true)
  expect(warned.length).toBe(1)
})

test('a name with selector metacharacters still finds its tag', () => {
  tag('a.b:c', '{"k":1}')
  let got = null as Record<string, unknown> | null
  resolveRecord('a.b:c', () => rec(), (_r, s) => { got = s })
  expect(got).toEqual({ k: 1 })
})

test('an installed resolver takes every access, even with a document present (R4)', () => {
  const made = rec()
  const calls: string[] = []
  __setServerResolver((name, create) => {
    calls.push(name)
    expect(create()).toBeDefined()
    return made
  })
  let flag: boolean | undefined
  const out = resolveRecord('r', (server) => { flag = server; return rec() }, () => {})
  expect(out).toBe(made)
  expect(calls).toEqual(['r'])
  expect(flag).toBe(true)
  expect((globalThis as Record<symbol, unknown>)[STORES]).toBeUndefined() // browser registry untouched
})

test('no resolver and no document throws "store \'x\' accessed on the server without a request scope"', () => {
  const d = (globalThis as { document?: unknown }).document
  delete (globalThis as { document?: unknown }).document
  try {
    expect(() => resolveRecord('x', () => rec(), () => {})).toThrow("store 'x' accessed on the server without a request scope")
  } finally {
    ;(globalThis as { document?: unknown }).document = d
  }
})

test('applyStoreSnapshot sets known signals of live records and skips unknown names and keys', () => {
  const n = signal(0)
  const plain = { n, label: 'x' }
  resolveRecord('live', () => rec(plain), () => {})
  applyStoreSnapshot({ live: { n: 5, label: 'y', missing: 1 }, ghost: { a: 1 } })
  expect(n()).toBe(5)
  expect(plain.label).toBe('x')
  applyStoreSnapshot({})
})
