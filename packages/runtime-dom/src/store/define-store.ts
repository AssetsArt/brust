// defineStore (M3-F D1): the 0.1.x `brustjs/store` handle on the shared reactive core and the
// globalThis registry. Resolution (browser registry / server resolver) lives in ./registry.
import { type Computed, type Signal, isComputed, isSignal } from '../signal'
import { type StoreInstanceRecord, resolveRecord } from './registry'

// Unwrap a Signal/Computed to its value type; `never` if it is neither. Uses `infer` (not
// `extends Signal<unknown>`): `Signal<T>.set(next: T)` is contravariant in T, so
// `Signal<TeamMember[]>` is NOT assignable to `Signal<unknown>` — a concrete-`unknown` check wrongly
// drops every typed signal key from the snapshot.
type StoreValue<X> = X extends Signal<infer T> ? T : X extends Computed<infer T> ? T : never

// Snapshot = plain-value view of a store: Signal<T>/Computed<T> → T, plain values kept as-is, action
// functions dropped. The `[…] extends [never]` tuple wrap stops `never` from distributing.
export type Snapshot<S> = {
  [K in keyof S as [StoreValue<S[K]>] extends [never]
    ? S[K] extends (...a: never[]) => unknown
      ? never
      : K
    : K]: [StoreValue<S[K]>] extends [never] ? S[K] : StoreValue<S[K]>
}

// C8. `then` is reserved so a store with a signal named `then` can't make the proxy an accidental
// thenable (await/Promise.resolve(handle) misbehaving).
const RESERVED = new Set(['name', 'subscribe', 'snapshot', 'serialize', 'hydrate', 'then'])

export interface StoreHandle<S extends object> {
  (): S
  readonly name: string
  subscribe(cb: () => void): () => void
  snapshot(): Snapshot<S>
  serialize(): Record<string, unknown>
  hydrate(state: Record<string, unknown>): void
}

// Each instance's signals must notify the store's subscriber set on write. After factory(), for every
// signal property we wrap .set to also bump the version and fire the store-level subscribers (computeds
// downstream recompute lazily; React re-reads snapshot).
function bridgeSubscribers(instance: Record<string, unknown>, subs: Set<() => void>, version: { n: number }): void {
  for (const key of Object.keys(instance)) {
    const sig = instance[key]
    if (!isSignal(sig)) continue
    const origSet = sig.set.bind(sig)
    sig.set = (next) => {
      // peek, not sig(): 0.1.x read with sig(), which subscribes a running effect to the written signal.
      const before = sig.peek()
      origSet(next as never)
      if (Object.is(before, sig.peek())) return
      version.n += 1
      for (const cb of Array.from(subs)) cb()
    }
  }
}

export function hydrateRecord(rec: StoreInstanceRecord, state: Record<string, unknown>): void {
  const inst = rec.instance as Record<string, unknown>
  for (const key of Object.keys(state)) {
    const v = inst[key]
    if (isSignal(v)) v.set(state[key])
  }
}

export function defineStore<S extends object>(name: string, factory: () => S): StoreHandle<S> & S {
  const create = (server: boolean): StoreInstanceRecord => {
    const instance = factory() as Record<string, unknown>
    const rec: StoreInstanceRecord = { instance, subs: new Set(), version: { n: 0 }, snap: null }
    bridgeSubscribers(instance, rec.subs, rec.version)
    if (server) rec.handle = handle // collectSnapshot() serializes through it
    return rec
  }
  const resolve = () => resolveRecord(name, create, hydrateRecord)

  const handle = (() => resolve().instance) as StoreHandle<S> & S
  Object.defineProperty(handle, 'name', { value: name })
  handle.subscribe = (cb) => {
    const rec = resolve()
    rec.subs.add(cb)
    return () => {
      rec.subs.delete(cb)
    }
  }
  handle.snapshot = () => {
    const rec = resolve()
    if (rec.snap && rec.snap.version === rec.version.n) return rec.snap.value as Snapshot<S>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(rec.instance)) {
      const v = (rec.instance as Record<string, unknown>)[key]
      if (isSignal(v) || isComputed(v)) out[key] = v()
    }
    rec.snap = { value: out, version: rec.version.n }
    return out as Snapshot<S>
  }
  handle.serialize = () => {
    const out: Record<string, unknown> = {}
    for (const [k, s] of Object.entries(resolve().instance)) {
      if (!isSignal(s)) continue
      const v = s.peek()
      if (v === undefined || typeof v === 'function') continue // spec §4
      if (typeof v === 'bigint') throw new TypeError(`store '${name}': '${k}' holds a BigInt, which JSON cannot carry`)
      out[k] = v
    }
    return out
  }
  handle.hydrate = (state) => hydrateRecord(resolve(), state)

  return new Proxy(handle, {
    get(target, prop, recv) {
      if (typeof prop === 'symbol' || RESERVED.has(prop)) return Reflect.get(target, prop, recv)
      return (resolve().instance as Record<string, unknown>)[prop]
    },
  })
}
