import { AsyncLocalStorage } from 'node:async_hooks'

// The resolved per-scope store record shared by the client registry and the
// server per-request map. `version` is bumped on every signal write so
// `snapshot()` can return a referentially-stable object (useSyncExternalStore
// contract) until a change; `snap` memoizes that object across repeated reads.
export interface StoreInstanceRecord {
  instance: object
  subs: Set<() => void>
  version: { n: number }
  snap: { value: Record<string, unknown>; version: number } | null
}

// A per-request store record: the shared record plus a `handle.serialize` so
// collectSnapshot() can serialize every touched store without re-resolving.
export interface StoreRecord extends StoreInstanceRecord {
  handle: { serialize(): Record<string, unknown> }
}

const storeContext = new AsyncLocalStorage<Map<string, StoreRecord>>()

export function runInStoreContext<T>(fn: () => T): T {
  return storeContext.run(new Map(), fn)
}

// Client builds its own registry; on the server this resolves the per-request map.
// `create` is required when first-accessing in a scope; reads pass it too (idempotent).
export function getServerInstance(name: string, create?: () => StoreRecord): StoreRecord {
  const map = storeContext.getStore()
  if (!map) {
    throw new Error(`store '${name}' accessed outside a request scope`)
  }
  let rec = map.get(name)
  if (!rec) {
    if (!create) throw new Error(`store '${name}' not initialized in this scope`)
    rec = create()
    map.set(name, rec)
  }
  return rec
}

export function collectSnapshot(): Record<string, Record<string, unknown>> | null {
  const map = storeContext.getStore()
  if (!map || map.size === 0) return null
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, rec] of map) out[name] = rec.handle.serialize()
  return out
}
