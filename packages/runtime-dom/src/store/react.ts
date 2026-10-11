// React bridge (M3-F D8). React is a PEER of @brust/runtime-dom, imported only here; src/index.ts never
// reaches this file, so the runtime bundle stays react-free (scripts/build.ts). Type-only import from
// the core: bundling this file into an island adds no second core (ruling R2).
import { useSyncExternalStore } from 'react'
import type { Snapshot, StoreHandle } from './define-store'

export function useStore<S extends object>(store: StoreHandle<S> & S): Snapshot<S> {
  // An ssr island can render (renderToString) on the server OUTSIDE a request store scope; there
  // store.snapshot() throws. Degrade to an empty snapshot for the server render so the island SSRs its
  // factory-default markup; the client resolves the real registry instance and hydrates.
  const serverSnapshot = (): Snapshot<S> => {
    try {
      return store.snapshot()
    } catch {
      return {} as Snapshot<S>
    }
  }
  return useSyncExternalStore(store.subscribe, store.snapshot, serverSnapshot)
}
