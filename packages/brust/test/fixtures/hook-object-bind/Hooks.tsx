import * as React from 'react'

// F289: a hook returning an object (or array) that holds a handler, bound whole at the call site.
export function useToggle() {
  const [on, setOn] = React.useState(false)
  const toggle = React.useCallback(() => setOn((o) => !o), [])
  return { on, toggle }
}

export function useCount(step: number) {
  const [n, setN] = React.useState(0)
  return { n, bump: () => setN(n + step), label: `+${step}` }
}

export function usePairOf() {
  const [on, setOn] = React.useState(false)
  const flip = () => setOn(!on)
  return [on, flip] as const
}

export function useMemoToggle() {
  const [on, setOn] = React.useState(false)
  const toggle = React.useCallback(() => setOn((o) => !o), [])
  return React.useMemo(() => ({ on, toggle }), [on, toggle])
}

export function useSpread(extra: { label: string }) {
  const [on, setOn] = React.useState(false)
  const toggle = React.useCallback(() => setOn((o) => !o), [])
  return { ...extra, on, toggle }
}
