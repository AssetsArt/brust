// runtime/store/react.ts — React adapter. Exported from the brustjs MAIN entry,
// never from ./store (which must stay react-free).
import { useSyncExternalStore } from 'react'
import type { Snapshot, StoreHandle } from './define-store.ts'

export function useStore<S extends object>(store: StoreHandle<S> & S): Snapshot<S> {
  // An `ssr` island can render (renderToString) on the server OUTSIDE a request
  // store scope — e.g. an ssr island on a native-jinja page, whose SSR runs after
  // the loader's `runInStoreContext` scope has closed. `store.snapshot()` throws
  // there (the S6 out-of-scope guard). Degrade to an empty snapshot for the
  // server render so the island SSRs its factory-default markup; the client
  // resolves the real window singleton and hydrates. Components that need a
  // specific initial on first paint should drive it from props until mounted
  // (Spec A does not server-seed native client state — that is Spec B).
  const serverSnapshot = (): Snapshot<S> => {
    try {
      return store.snapshot()
    } catch {
      return {} as Snapshot<S>
    }
  }
  return useSyncExternalStore(store.subscribe, store.snapshot, serverSnapshot)
}
