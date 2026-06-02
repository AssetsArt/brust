import { type Computed, type Signal, isComputed, isSignal } from './signal.ts'
import { parseStoreScript } from './serialize.ts'
import { getServerInstance, type StoreInstanceRecord } from './server-context.ts'

export type Snapshot<S> = {
  [K in keyof S as S[K] extends (...a: never[]) => unknown
    ? S[K] extends Signal<unknown> | Computed<unknown>
      ? K
      : never
    : K]: S[K] extends Signal<infer T> ? T : S[K] extends Computed<infer T> ? T : S[K]
}

// `then` is reserved so a store with a signal named `then` can't make the proxy
// an accidental thenable (await/Promise.resolve(handle) misbehaving).
const RESERVED = new Set(['name', 'subscribe', 'snapshot', 'serialize', 'hydrate', 'then'])

export interface StoreHandle<S extends object> {
  (): S
  readonly name: string
  subscribe(cb: () => void): () => void
  snapshot(): Snapshot<S>
  serialize(): Record<string, unknown>
  hydrate(state: Record<string, unknown>): void
}

// `StoreInstanceRecord` is the resolved per-scope (client singleton or server
// per-request) store record; it lives in server-context.ts so both scopes and
// `StoreRecord` share one shape.
export type { StoreInstanceRecord }

interface ClientRegistry {
  [name: string]: StoreInstanceRecord
}
function clientRegistry(): ClientRegistry {
  const w = window as unknown as { __BRUST_STORES__?: ClientRegistry }
  if (!w.__BRUST_STORES__) w.__BRUST_STORES__ = {}
  return w.__BRUST_STORES__
}

// We need each instance's signals to notify the store's subscriber set on write.
// signal.ts subscribers are internal; to bridge to React's subscribe, defineStore
// wraps the instance: after factory(), for every signal property we wrap .set to
// also bump the version and fire the store-level subscriber set. (computed
// downstream of those signals recomputes lazily; React re-reads snapshot.)
function bridgeSubscribers(
  instance: Record<string, unknown>,
  subs: Set<() => void>,
  version: { n: number },
): void {
  for (const key of Object.keys(instance)) {
    const v = instance[key]
    if (isSignal(v)) {
      const sig = v as Signal<unknown>
      const origSet = sig.set.bind(sig)
      sig.set = (next) => {
        // origSet is a no-op when Object.is(prev,next). Reading sig() here is
        // outside any active consumer, so it registers no dependency — we can
        // compare before/after and only bump+notify on a real change, avoiding
        // spurious React re-renders.
        const before = sig()
        origSet(next as never)
        const after = sig()
        if (Object.is(before, after)) return
        version.n += 1
        for (const cb of [...subs]) cb()
      }
    }
  }
}

export function defineStore<S extends object>(name: string, factory: () => S): StoreHandle<S> & S {
  function createRecord(): StoreInstanceRecord {
    const instance = factory() as object
    const subs = new Set<() => void>()
    const version = { n: 0 }
    bridgeSubscribers(instance as Record<string, unknown>, subs, version)
    return { instance, subs, version, snap: null }
  }

  function resolve(): StoreInstanceRecord {
    if (typeof window !== 'undefined') {
      const reg = clientRegistry()
      if (!reg[name]) {
        reg[name] = createRecord()
        // hydrate from server-injected <script> if present (first access only).
        const el = document.querySelector(`script[data-brust-store="${name}"]`)
        if (el) hydrateRecord(reg[name], parseStoreScript(el))
      }
      return reg[name]
    }
    // server: per-request via AsyncLocalStorage. StoreRecord extends
    // StoreInstanceRecord (adds `handle`), so the return is assignable directly.
    return getServerInstance(name, () => {
      const rec = createRecord()
      return { ...rec, handle: handle as StoreHandle<object> }
    })
  }

  function hydrateRecord(rec: StoreInstanceRecord, state: Record<string, unknown>): void {
    const inst = rec.instance as Record<string, unknown>
    for (const key of Object.keys(state)) {
      const v = inst[key]
      if (isSignal(v)) (v as Signal<unknown>).set(state[key])
    }
  }

  const handle = (() => resolve().instance) as StoreHandle<S> & S
  Object.defineProperty(handle, 'name', { value: name })
  handle.subscribe = (cb) => {
    const rec = resolve()
    rec.subs.add(cb)
    return () => rec.subs.delete(cb)
  }
  handle.snapshot = () => {
    const rec = resolve()
    if (rec.snap && rec.snap.version === rec.version.n) {
      return rec.snap.value as Snapshot<S>
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(rec.instance as object)) {
      const v = (rec.instance as Record<string, unknown>)[key]
      if (isSignal(v) || isComputed(v)) out[key] = (v as () => unknown)()
    }
    rec.snap = { value: out, version: rec.version.n }
    return out as Snapshot<S>
  }
  handle.serialize = () => {
    const rec = resolve()
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(rec.instance as object)) {
      const v = (rec.instance as Record<string, unknown>)[key]
      if (isSignal(v)) out[key] = (v as () => unknown)()
    }
    return out
  }
  handle.hydrate = (state) => {
    hydrateRecord(resolve(), state)
  }

  return new Proxy(handle, {
    get(target, prop, recv) {
      if (typeof prop === 'symbol' || RESERVED.has(prop)) {
        return Reflect.get(target, prop, recv)
      }
      const rec = resolve()
      return (rec.instance as Record<string | symbol, unknown>)[prop]
    },
  }) as StoreHandle<S> & S
}
