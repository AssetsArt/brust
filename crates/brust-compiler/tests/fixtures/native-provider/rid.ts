import * as React from 'react'
import { useLayoutEffect } from './rlayout'

// Radix's `useId` as published: a React 18 `useId` with a client-only fallback counter for older React
const useReactId = (React as any)[' useId '.trim().toString()] || (() => undefined)
let count = 0

export function useId(deterministicId?: string): string {
  const [id, setId] = React.useState<string | undefined>(useReactId())
  useLayoutEffect(() => {
    if (!deterministicId) setId((reactId) => reactId ?? String(count++))
  }, [deterministicId])
  return deterministicId || (id ? `radix-${id}` : '')
}
