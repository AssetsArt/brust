import { afterEach, beforeEach, expect, test } from 'bun:test'
import { computed, effect, signal } from '../../src/signal'
import { defineStore } from '../../src/store/define-store'
import { type StoreInstanceRecord, __setServerResolver, _resetStores } from '../../src/store/registry'

// A test-local stand-in for the server lane's runInStoreContext.
let scope: Map<string, StoreInstanceRecord> | null = null
const inScope = <T>(fn: () => T): T => {
  scope = new Map()
  try {
    return fn()
  } finally {
    scope = null
  }
}
const installResolver = () =>
  __setServerResolver((name, create) => {
    if (!scope) throw new Error(`store '${name}' accessed outside a request scope`)
    let r = scope.get(name)
    if (!r) {
      r = create()
      scope.set(name, r)
    }
    return r
  })

beforeEach(installResolver)
afterEach(() => {
  __setServerResolver(null)
  _resetStores()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

let storeSeq = 0
function makeTeamStore() {
  return defineStore(`team-${storeSeq++}`, () => {
    const members = signal<string[]>([])
    const count = computed(() => members().length)
    return {
      members,
      count,
      add(name: string) {
        members.set((m) => [...m, name])
      },
    }
  })
}

test('proxy reads the active instance signal handle and calls methods', () => {
  const team = makeTeamStore()
  inScope(() => {
    expect(typeof team.members).toBe('function')
    expect(team.members()).toEqual([])
    team.add('ash')
    expect(team.members()).toEqual(['ash'])
  })
})

test('serialize includes signal values, excludes computed + functions', () => {
  const team = makeTeamStore()
  inScope(() => {
    team.add('ash')
    const ser = team.serialize()
    expect(ser).toEqual({ members: ['ash'] })
    expect('count' in ser).toBe(false)
    expect('add' in ser).toBe(false)
  })
})

test('hydrate sets the signal; snapshot reflects it; computed is evaluated value', () => {
  const team = makeTeamStore()
  inScope(() => {
    team.hydrate({ members: ['a', 'b'], nope: 1 }) // unknown key ignored (D1)
    const snap = team.snapshot()
    expect(snap.members).toEqual(['a', 'b'])
    expect(snap.count).toBe(2)
    expect('nope' in snap).toBe(false)
  })
})

test('snapshot is referentially stable until a write', () => {
  const team = makeTeamStore()
  inScope(() => {
    const s1 = team.snapshot()
    expect(team.snapshot()).toBe(s1)
    team.add('x')
    const s3 = team.snapshot()
    expect(s3).not.toBe(s1)
    expect(team.snapshot()).toBe(s3)
  })
})

test('subscribe fires on write within the scope', () => {
  const team = makeTeamStore()
  inScope(() => {
    let fired = 0
    const unsub = team.subscribe(() => {
      fired++
    })
    team.add('a')
    expect(fired).toBe(1)
    unsub()
    team.add('b')
    expect(fired).toBe(1)
  })
})

test('no-op .set does not fire subscribers and keeps snapshot reference stable', () => {
  const store = defineStore(`noop-${storeSeq++}`, () => ({ n: signal(1) }))
  inScope(() => {
    let fired = 0
    store.subscribe(() => {
      fired++
    })
    const snap1 = store.snapshot()
    store.n.set(1)
    expect(fired).toBe(0)
    expect(store.snapshot()).toBe(snap1)
  })
})

test("RESERVED blocks a 'then' signal so the handle is not an accidental thenable", async () => {
  const store = defineStore(`thenable-${storeSeq++}`, () => ({ then: signal(1) }))
  await inScope(async () => {
    expect((store as { then?: unknown }).then).toBeUndefined()
    const resolved = await Promise.resolve(store as unknown)
    expect(resolved).toBe(store)
  })
})

test('two distinct defineStore handles share the same window registry instance', () => {
  __setServerResolver(null)
  const make = () =>
    defineStore('counter', () => {
      const n = signal(0)
      return { n, inc() { n.set((v) => v + 1) } }
    })
  const a = make()
  const b = make()
  let aFired = 0
  a.subscribe(() => {
    aFired++
  })
  b.inc()
  expect(aFired).toBe(1)
  expect(a.n()).toBe(1)
  expect(b.n()).toBe(1)
})

test('first client access hydrates from injected <script data-brust-store>', () => {
  __setServerResolver(null)
  const el = document.createElement('script')
  el.setAttribute('type', 'application/json')
  el.setAttribute('data-brust-store', 'profile')
  el.textContent = JSON.stringify({ handle: 'ash' })
  document.head.appendChild(el)

  const profile = defineStore('profile', () => {
    const handleName = signal('')
    const upper = computed(() => handleName().toUpperCase())
    return { handle: handleName, upper }
  })
  expect(profile.handle()).toBe('ash')
  expect(profile.snapshot().upper).toBe('ASH')
})

test('first factory wins per name', () => {
  __setServerResolver(null)
  const a = defineStore('dup', () => ({ n: signal(1) }))
  const b = defineStore('dup', () => ({ n: signal(2) }))
  expect(a.n()).toBe(1)
  expect(b.n()).toBe(1)
})

test('serialize drops undefined and function signal values', () => {
  const s = defineStore(`drop-${storeSeq++}`, () => ({
    keep: signal(1),
    u: signal<number | undefined>(undefined),
    f: signal<() => void>(() => {}),
  }))
  inScope(() => {
    expect(s.serialize()).toEqual({ keep: 1 })
  })
})

test('serialize throws naming the store and key for a BigInt', () => {
  const s = defineStore('big', () => ({ n: signal(10n) }))
  inScope(() => {
    expect(() => s.serialize()).toThrow(/store 'big'.*'n'/)
  })
})

test('server path outside a scope throws "outside a request scope"', () => {
  const s = defineStore(`out-${storeSeq++}`, () => ({ n: signal(1) }))
  expect(() => s.n()).toThrow(/outside a request scope/)
})

test('a write inside an effect does not subscribe the effect to the written signal', () => {
  __setServerResolver(null)
  const s = defineStore(`peek-${storeSeq++}`, () => ({ n: signal(0) }))
  let runs = 0
  effect(() => {
    runs++
    s.n.set(1) // the bridge reads with peek(): no dependency on n is recorded
  })
  expect(runs).toBe(1)
  s.n.set(2)
  expect(runs).toBe(1)
})
