import * as React from 'react'

// F285 / F286: the shape of Radix's `useStateMachine`: a custom hook that returns `useReducer(...)` directly.
export function useMachine(initial: string, machine: Record<string, Record<string, string>>) {
  return React.useReducer((state: string, event: string): string => machine[state]?.[event] ?? state, initial)
}
