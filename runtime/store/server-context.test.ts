import { expect, test } from 'bun:test'
import { collectSnapshot, getServerInstance, runInStoreContext } from './server-context.ts'

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
    handle: { serialize: () => ({ value }) },
  }
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
      // After awaiting, the record we read MUST still be this scope's own.
      return rec.value
    })
  }
  // Start scope 1 (long delay) and scope 2 (short delay) interleaved.
  const [r1, r2] = await Promise.all([scope(1, 20), scope(2, 1)])
  expect(r1).toBe(1)
  expect(r2).toBe(2)
})
