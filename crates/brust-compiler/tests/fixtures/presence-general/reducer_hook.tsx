import * as React from 'react'
function useMachine(initial: string, machine: Record<string, Record<string, string>>) {
  return React.useReducer((state: string, event: string): string => machine[state]?.[event] ?? state, initial)
}
export default function P() {
  const [state, send] = useMachine('a', { a: { GO: 'b' }, b: {} })
  return <button type="button" onClick={() => send('GO')}>{state}</button>
}
