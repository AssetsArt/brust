// Browser store registry + the server-resolver hook (M3-F D3/D6/C7).
// The registry lives on globalThis (C7) so two copies of this module share one instance per name.
import { parseStoreScript } from './serialize'

// The resolved per-scope store record, shared by the browser registry and the server per-request
// map. `version` bumps on every signal write so `snapshot()` returns a referentially-stable object
// (useSyncExternalStore contract) until a change; `snap` memoizes it. `handle` is set only on
// records created for a resolver, so collectSnapshot() can serialize a touched store.
export interface StoreInstanceRecord {
  instance: object
  subs: Set<() => void>
  version: { n: number }
  snap: { value: Record<string, unknown>; version: number } | null
  handle?: { serialize(): Record<string, unknown> }
}

export type ServerResolver = (name: string, create: () => StoreInstanceRecord) => StoreInstanceRecord

const STORES = Symbol.for('brust.stores') // C7
type Registry = Record<string, StoreInstanceRecord>

// Module-local on purpose (as in 0.1.x): a second runtime-dom copy on the SERVER has no resolver
// and throws loudly instead of leaking request state into a shared registry.
let serverResolver: ServerResolver | null = null

/** Installed once at worker boot by packages/brust/src/store/server-context.ts; null uninstalls (tests). */
export function __setServerResolver(fn: ServerResolver | null): void {
  serverResolver = fn
}

function browserRegistry(): Registry {
  const g = globalThis as { [STORES]?: Registry }
  return (g[STORES] ??= Object.create(null) as Registry)
}

// Attribute comparison, never a built selector: the name is not escaped for CSS.
function seedScript(name: string): Element | null {
  for (const el of Array.from(document.querySelectorAll('script[data-brust-store]'))) {
    if (el.getAttribute('data-brust-store') === name) return el
  }
  return null
}

/**
 * Resolution order (ruling R4): an installed resolver takes EVERY access; otherwise the browser
 * registry when `document` exists (created, then lazily seeded from the page's script tag on the
 * first access per name, D6); otherwise throw.
 */
export function resolveRecord(
  name: string,
  create: (server: boolean) => StoreInstanceRecord,
  seed: (rec: StoreInstanceRecord, state: Record<string, unknown>) => void,
): StoreInstanceRecord {
  if (serverResolver) return serverResolver(name, () => create(true))
  if (typeof document === 'undefined') {
    throw new Error(`store '${name}' accessed on the server without a request scope`)
  }
  const reg = browserRegistry()
  let rec = reg[name]
  if (!rec) {
    rec = reg[name] = create(false)
    const el = seedScript(name)
    if (el) seed(rec, parseStoreScript(el))
  }
  return rec
}

/** Apply a navigation-payload snapshot to live client stores. Reserved for the SPA wave (D9): no callers yet. */
export function applyStoreSnapshot(snap: Record<string, Record<string, unknown>>): void {
  const reg = (globalThis as { [STORES]?: Registry })[STORES]
  if (!reg) return
  for (const [name, state] of Object.entries(snap)) {
    const entry = reg[name]
    if (!entry) continue // not defined on the client yet: the initial-load <script> covers it
    const inst = entry.instance as Record<string, { set?: (x: unknown) => void } | undefined>
    for (const key of Object.keys(state)) {
      const v = inst[key]
      if (v && typeof v.set === 'function') v.set(state[key])
    }
  }
}

export function _resetStores(): void {
  delete (globalThis as { [STORES]?: unknown })[STORES]
}
