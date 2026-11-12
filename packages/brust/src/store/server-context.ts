// packages/brust/src/store/server-context.ts — the per-request store scope (design D4, D8). Server-only;
// never imported by client code. No runtime import from core: `core-adapter.ts` registers
// `getServerInstance` as core's resolver at worker boot (S8).
import { AsyncLocalStorage } from 'node:async_hooks'
import { isStoreHandle, type StoreRecord, type StoreSnapshot, WRITTEN } from './core-adapter'

interface Scope {
  records: Map<string, StoreRecord>
  seed: StoreSnapshot | null
}
const storeContext = new AsyncLocalStorage<Scope>()

/** Runs `fn` in a fresh scope. `seed` (an ssr job's `inputs.__store`) hydrates each store on its first access. */
export function runInStoreContext<T>(fn: () => T, seed: StoreSnapshot | null = null): T {
  return storeContext.run({ records: new Map(), seed }, fn)
}

export function getServerInstance(name: string, create: () => StoreRecord): StoreRecord {
  const scope = storeContext.getStore()
  if (!scope) throw new Error(`store '${name}' accessed outside a request scope`) // R5: 0.1.x verbatim
  let rec = scope.records.get(name)
  if (!rec) {
    rec = create()
    scope.records.set(name, rec) // before hydrate: handle.hydrate resolves back to this record
    const s = scope.seed?.[name]
    if (s && typeof s === 'object') {
      const { [WRITTEN]: _, ...state } = s // F533: the seed is a loader's snapshot; its written-key list is not state
      rec.handle?.hydrate(state) // a seed: core marks nothing it sets as written
    }
  }
  return rec
}

/** Touched stores only; `null` when none (C2: then `store` is omitted, R1). A store the scope wrote to carries the
 * written keys under the reserved `~w` (F533: a navigation sets exactly those on a live client store). */
export function collectSnapshot(): StoreSnapshot | null {
  const scope = storeContext.getStore()
  if (!scope || scope.records.size === 0) return null
  const out: StoreSnapshot = {}
  for (const [name, rec] of scope.records) {
    const state = rec.handle ? rec.handle.serialize() : {}
    if (rec.written?.size) state[WRITTEN] = [...rec.written]
    out[name] = state
  }
  return out
}

const warned = new Set<string>()
/** D4: resolve every store handle exported by each module (C3 paths → `jobs.js` `stores` table, R2), so its
 * defaults are in the snapshot even if no loader touched it. Must run inside a scope. */
export function touchStores(modules: readonly string[], table: Readonly<Record<string, object>>): void {
  for (const p of modules) {
    const mod = table[p]
    if (!mod) {
      if (!warned.has(p)) {
        warned.add(p)
        console.warn(`[brust] store module ${p} is not in jobs.js (rebuild?)`)
      }
      continue
    }
    for (const v of Object.values(mod)) if (isStoreHandle(v)) v()
  }
}
