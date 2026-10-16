import * as React from 'react'
import { useLayoutEffect } from './rlayout'

const useReactId = (React as any)[' useId '.trim().toString()] || (() => undefined)
let count = 0
function bump() {
  count += 10
  return true
}

// the same identity update as Radix's, but its `if` TEST has a side effect: dropping the effect would drop `bump()` too
export function useId(deterministicId?: string): string {
  const [id, setId] = React.useState<string | undefined>(useReactId())
  useLayoutEffect(() => {
    if (bump()) setId((reactId) => reactId ?? String(count++))
  }, [deterministicId])
  return deterministicId || (id ? `radix-${id}` : '')
}
