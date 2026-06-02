import { AsyncLocalStorage } from 'node:async_hooks'

// A per-request store record. `instance`/`subs` mirror the client registry shape;
// `version`/`snap` carry defineStore's snapshot memo so it survives across the
// repeated getServerInstance reads within one request. `handle.serialize` lets
// collectSnapshot() serialize every touched store without re-resolving.
export interface StoreRecord {
  instance: object
  subs: Set<() => void>
  version?: { n: number }
  snap?: { value: Record<string, unknown>; version: number } | null
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
