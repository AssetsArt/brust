// packages/brust/src/store/core-adapter.ts — the ONE file that names the store-core lane's API
// (design §2.1, C7/C8). Until m3f-store-core merges it holds only the shapes this lane expects;
// S8 adds the import. A mismatch with core is fixed here, in one line.

/** C1: `{ [storeName]: { [signalKey]: Json } }`. */
export type StoreSnapshot = Record<string, Record<string, unknown>>

/** What core's server-side `create()` returns (0.1.x `StoreInstanceRecord` + `handle`). EXPECTED of core:
 * `handle.serialize()` = top-level signal values (D1); `handle.hydrate(s)` sets signals, ignores unknown keys. */
export interface StoreRecord {
  instance: object
  handle?: { serialize(): Record<string, unknown>; hydrate(state: Record<string, unknown>): void }
}

/** EXPECTED core hook: `__setServerResolver(fn: ServerResolver)` exported by `@brust/runtime-dom/store`. */
export type ServerResolver = (name: string, create: () => StoreRecord) => StoreRecord

/** A `defineStore` handle (C8 reserved members). Duck-typed: core exports no brand for handles. */
export function isStoreHandle(v: unknown): v is (() => object) & { readonly name: string } {
  if (typeof v !== 'function') return false
  const h = v as unknown as Record<string, unknown>
  return (
    typeof h.name === 'string' &&
    ['subscribe', 'snapshot', 'serialize', 'hydrate'].every((k) => typeof h[k] === 'function')
  )
}
