import * as React from 'react'
function useBoth(start: number) { return React.useState(start) }
function useCb() { return React.useCallback(() => 1, []) }
export default function P() {
  const [n, setN] = useBoth(1)
  const cb = useCb()
  return <button type="button" onClick={() => { setN(n + cb()) }}>{n}</button>
}
