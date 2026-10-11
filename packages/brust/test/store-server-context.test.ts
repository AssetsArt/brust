import { expect, spyOn, test } from 'bun:test'
import {
  collectSnapshot,
  getServerInstance,
  runInStoreContext,
  touchStores,
} from '../src/store/server-context'
import { isStoreHandle } from '../src/store/core-adapter'

function makeRecord(initial: number) {
  let value = initial
  return {
    instance: {} as object,
    subs: new Set<() => void>(),
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
  }
}

function fakeHandle(name: string, extra: Record<string, unknown> = {}) {
  const fn = (() => ({})) as unknown as Record<string, unknown>
  Object.defineProperty(fn, 'name', { value: name })
  for (const k of ['subscribe', 'snapshot', 'serialize', 'hydrate']) fn[k] = () => undefined
  return Object.assign(fn, extra) as unknown as (() => object) & { readonly name: string }
}

test('runInStoreContext runs fn with a fresh map; getServerInstance creates once per scope', () => {
  runInStoreContext(() => {
    let creations = 0
    const create = () => {
      creations++
      return makeRecord(1)
    }
    const a = getServerInstance('s', create)
    const b = getServerInstance('s', create)
    expect(a).toBe(b)
    expect(creations).toBe(1)
  })
})

test('getServerInstance outside any scope throws "outside a request scope"', () => {
  expect(() => getServerInstance('s', () => makeRecord(1))).toThrow(/outside a request scope/)
})

test('collectSnapshot returns {name: serialized} for touched stores; null if none', () => {
  runInStoreContext(() => {
    expect(collectSnapshot()).toBeNull()
    const rec = getServerInstance('alpha', () => makeRecord(7)) as ReturnType<typeof makeRecord>
    rec.value = 42
    expect(collectSnapshot()).toEqual({ alpha: { value: 42 } })
  })
})

test('INTERLEAVE ISOLATION (S6): two scopes awaiting between mutations do not cross-contaminate', async () => {
  async function scope(id: number, delay: number): Promise<number> {
    return runInStoreContext(async () => {
      const rec = getServerInstance('iso', () => makeRecord(0)) as ReturnType<typeof makeRecord>
      rec.value = id
      await new Promise((r) => setTimeout(r, delay))
      return rec.value
    })
  }
  const [r1, r2] = await Promise.all([scope(1, 20), scope(2, 1)])
  expect(r1).toBe(1)
  expect(r2).toBe(2)
})

test('seeded scope hydrates a record on creation', () => {
  const v = runInStoreContext(
    () => (getServerInstance('alpha', () => makeRecord(1)) as ReturnType<typeof makeRecord>).value,
    { alpha: { value: 9 } },
  )
  expect(v).toBe(9)
})

test('seed for an untouched name creates nothing', () => {
  runInStoreContext(
    () => {
      expect(collectSnapshot()).toBeNull()
    },
    { alpha: { value: 9 } },
  )
})

test('nested scopes are independent', () => {
  runInStoreContext(() => {
    const outer = getServerInstance('n', () => makeRecord(1)) as ReturnType<typeof makeRecord>
    runInStoreContext(() => {
      const inner = getServerInstance('n', () => makeRecord(1)) as ReturnType<typeof makeRecord>
      expect(inner).not.toBe(outer)
      inner.value = 99
    })
    expect(outer.value).toBe(1)
  })
})

test('touchStores resolves every store handle a module exports', () => {
  let calls = 0
  const cart = fakeHandle('cart')
  const wrapped = (() => {
    calls++
    return {}
  }) as unknown as typeof cart
  for (const k of ['subscribe', 'snapshot', 'serialize', 'hydrate'])
    (wrapped as unknown as Record<string, unknown>)[k] = () => undefined
  Object.defineProperty(wrapped, 'name', { value: 'cart' })
  let helperCalls = 0
  const helper = () => {
    helperCalls++
    return 1
  }
  touchStores(['a.ts'], { 'a.ts': { cart: wrapped, helper, n: 3 } })
  expect(calls).toBe(1)
  expect(helperCalls).toBe(0)
})

test('touchStores warns once for a module missing from the table and does not throw', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(() => touchStores(['missing.ts'], {})).not.toThrow()
    touchStores(['missing.ts'], {})
    expect(warn).toHaveBeenCalledTimes(1)
  } finally {
    warn.mockRestore()
  }
})

test('isStoreHandle duck-types C8 members', () => {
  expect(isStoreHandle(fakeHandle('x'))).toBe(true)
  expect(isStoreHandle(() => 1)).toBe(false)
  expect(isStoreHandle({})).toBe(false)
})
