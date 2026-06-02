// This module is the ONLY one in runtime/store that imports a Node builtin
// (node:async_hooks). define-store.ts must NOT import it statically — it is
// reachable from browser/island bundles (brustjs/store, brustjs/client). Instead
// we register the per-request resolver into define-store via __setServerResolver
// at module load; the server pulls this module in via routes.ts (runInStoreContext
// / collectSnapshot), so the resolver is installed before any request runs.
import { AsyncLocalStorage } from 'node:async_hooks'
import { __setServerResolver, type StoreInstanceRecord } from './define-store.ts'

const storeContext = new AsyncLocalStorage<Map<string, StoreInstanceRecord>>()

export function runInStoreContext<T>(fn: () => T): T {
  return storeContext.run(new Map(), fn)
}

// Resolve (create-once) the per-request instance for `name` in the active scope.
// Exported for direct unit testing; production code reaches it via the resolver
// registered into define-store.ts below.
export function getServerInstance(
  name: string,
  create: () => StoreInstanceRecord,
): StoreInstanceRecord {
  const map = storeContext.getStore()
  if (!map) {
    throw new Error(`store '${name}' accessed outside a request scope`)
  }
  let rec = map.get(name)
  if (!rec) {
    rec = create()
    map.set(name, rec)
  }
  return rec
}

export function collectSnapshot(): Record<string, Record<string, unknown>> | null {
  const map = storeContext.getStore()
  if (!map || map.size === 0) return null
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, rec] of map) out[name] = rec.handle ? rec.handle.serialize() : {}
  return out
}

__setServerResolver(getServerInstance)
