import * as React from 'react'
import { useIsHydrated as useIsHydratedLegacy } from './rhydr_legacy'

// Radix's `use-is-hydrated` 0.1.3 as published: the modern hook when React has useSyncExternalStore, else the legacy one
const useReactSyncExternalStore: typeof React.useSyncExternalStore | undefined = (React as any)[
  ' useSyncExternalStore '.trim().toString()
]

function subscribe() {
  return () => {}
}

function useIsHydratedModern() {
  return useReactSyncExternalStore!(
    subscribe,
    () => true,
    () => false,
  )
}

export const useIsHydrated =
  typeof useReactSyncExternalStore !== 'function' ? useIsHydratedLegacy : useIsHydratedModern
