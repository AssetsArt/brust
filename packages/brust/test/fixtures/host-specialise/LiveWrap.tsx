import { createContext, useContext, useState } from 'react'

// F348 served: Radix Progress's shape (a Provider computed from props, specialised per call site) under a wrapper with an
// instance of its own (F345/F320): the wrapper's props follow its caller, and so does the clone it specialises.
const V = createContext<{ state: string }>({ state: 'loading' })
function stateOf(value: number, max: number) {
  return value === max ? 'complete' : 'loading'
}
function Root({ value, max = 100, children }: { value: number; max?: number; children?: React.ReactNode }) {
  return (
    <V.Provider value={{ state: stateOf(value, max) }}>
      <div data-max={max}>{children}</div>
    </V.Provider>
  )
}
function Indicator() {
  const c = useContext(V)
  return <i data-state={c.state} />
}
export function LiveWrap({ value }: { value: number }) {
  const [n, setN] = useState(0)
  return (
    <section data-testid="box" data-n={n} onClick={() => setN(n + 1)}>
      <b>{n}</b>
      <Root value={value} max={2}>
        <Indicator />
      </Root>
    </section>
  )
}
