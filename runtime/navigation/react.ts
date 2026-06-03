// React view-layer adapter for the navigation store. Lives OUTSIDE navigation/
// index.ts (which stays React-free + in the typecheck:treaty gate) and is reached
// only via brustjs/client, the browser/island entry. Uses useSyncExternalStore so
// a React island re-renders on every navigation transition; getNavState is
// version-memoized (store.ts) so the snapshot is referentially stable.
import { useSyncExternalStore } from 'react'
import { getNavState, subscribe, type NavState } from './store.ts'

/** Watch the navigation state from a React island.
 *
 * ```tsx
 * import { useNav } from 'brustjs/client'
 * function Crumb() {
 *   const { path, phase } = useNav()
 *   return <span>{phase === 'loading' ? 'Loading…' : path}</span>
 * }
 * ```
 *
 * The third arg (server snapshot) is the same getter — on the server the store
 * holds its idle defaults (no `location`), so SSR renders the idle state and the
 * client hydrates the real one on mount. */
export function useNav(): NavState {
  return useSyncExternalStore(subscribe, getNavState, getNavState)
}
