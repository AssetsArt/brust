import { beforeEach, expect, test } from 'bun:test'
import { defineStore } from './define-store.ts'
import { computed, signal } from './signal.ts'
import { runInStoreContext } from './server-context.ts'

// These tests run on the server (no window) — they exercise the per-request
// AsyncLocalStorage branch via runInStoreContext. A sibling happy-dom test file
// in the same `bun test` process may leak a global `window`; defineStore picks
// the branch at resolve()-time, so force the server branch here.
beforeEach(() => {
  if (typeof (globalThis as Record<string, unknown>).window !== 'undefined') {
    ;(globalThis as Record<string, unknown>).window = undefined
  }
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
  runInStoreContext(() => {
    expect(typeof team.members).toBe('function')
    expect(team.members()).toEqual([])
    team.add('ash')
    expect(team.members()).toEqual(['ash'])
  })
})

test('serialize includes signal values, excludes computed + functions', () => {
  const team = makeTeamStore()
  runInStoreContext(() => {
    team.add('ash')
    const ser = team.serialize()
    expect(ser).toEqual({ members: ['ash'] })
    expect('count' in ser).toBe(false)
    expect('add' in ser).toBe(false)
  })
})

test('hydrate sets the signal; snapshot reflects it; computed is evaluated value', () => {
  const team = makeTeamStore()
  runInStoreContext(() => {
    team.hydrate({ members: ['a', 'b'] })
    const snap = team.snapshot()
    expect(snap.members).toEqual(['a', 'b'])
    expect(snap.count).toBe(2)
  })
})

test('snapshot is referentially stable until a write', () => {
  const team = makeTeamStore()
  runInStoreContext(() => {
    const s1 = team.snapshot()
    const s2 = team.snapshot()
    expect(s1).toBe(s2)
    team.add('x')
    const s3 = team.snapshot()
    expect(s3).not.toBe(s1)
    const s4 = team.snapshot()
    expect(s4).toBe(s3)
  })
})

test('subscribe fires on write within the scope', () => {
  const team = makeTeamStore()
  runInStoreContext(() => {
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
  const store = defineStore(`noop-${storeSeq++}`, () => {
    const n = signal(1)
    return { n }
  })
  runInStoreContext(() => {
    let fired = 0
    store.subscribe(() => {
      fired++
    })
    const snap1 = store.snapshot()
    ;(store.n as ReturnType<typeof signal<number>>).set(1) // same value → no-op
    expect(fired).toBe(0)
    const snap2 = store.snapshot()
    expect(snap2).toBe(snap1)
  })
})

test("RESERVED blocks a 'then' signal so the handle is not an accidental thenable", async () => {
  const store = defineStore(`thenable-${storeSeq++}`, () => {
    const then = signal(1)
    return { then }
  })
  await runInStoreContext(async () => {
    // handle.then resolves to the handle's own (absent) `then`, not the signal.
    expect((store as { then?: unknown }).then).toBeUndefined()
    // Promise.resolve(handle) must not treat it as a thenable and hang.
    const resolved = await Promise.resolve(store)
    expect(resolved).toBe(store)
  })
})
