import * as React from 'react'

// Radix's `use-is-hydrated` as published
export function useIsHydrated(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
}

function subscribe() {
  return () => {}
}
