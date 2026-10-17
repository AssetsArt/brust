import { createContext, useContext } from 'react'
// Radix Progress's shape: a Provider whose value is computed from its props (no state of its own), specialised per call
// site (R34.122), and a consumer under it.
const V = createContext<{ state: string }>({ state: 'loading' })
function stateOf(value: number, max: number) {
  return value === max ? 'complete' : 'loading'
}
export function Root({ value, max = 100, children }: { value: number; max?: number; children?: React.ReactNode }) {
  return (
    <V.Provider value={{ state: stateOf(value, max) }}>
      <div data-max={max}>{children}</div>
    </V.Provider>
  )
}
export function Indicator() {
  const c = useContext(V)
  return <i data-state={c.state} />
}
