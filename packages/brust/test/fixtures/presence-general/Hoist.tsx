import * as React from 'react'

// F286: hook calls in the return position and in a returned object literal.
export function usePair(start: number) {
  return React.useState(start)
}

export function useToggle() {
  const [on, setOn] = React.useState(false)
  return { on, toggle: React.useCallback(() => setOn((o) => !o), []), label: React.useMemo(() => 'toggle', []) }
}
