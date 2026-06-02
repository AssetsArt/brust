// runtime/store/react.ts — React adapter. Exported from the brustjs MAIN entry,
// never from ./store (which must stay react-free).
import { useSyncExternalStore } from 'react'
import type { Snapshot, StoreHandle } from './define-store.ts'

export function useStore<S extends object>(store: StoreHandle<S> & S): Snapshot<S> {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}
