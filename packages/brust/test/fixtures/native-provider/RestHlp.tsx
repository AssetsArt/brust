import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// Radix's `Switch` shape in one module: the component spreads ITS rest into a consumer under its Provider (F278), and
// the consumer paints `getState(checked)` (F279)
const M = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })

function getState(on: boolean) {
  return on ? 'checked' : 'unchecked'
}

function RProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <M.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</M.Provider>
}
function RTrigger({ children, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const c = useContext(M)
  // an instance of its own (a ref and an effect), so the frame's live fields reach it as props next to the spread
  const r = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    r.current?.setAttribute('data-mounted', '1')
  }, [])
  return (
    <button ref={r} type="button" {...rest} aria-pressed={c.on} data-state={getState(c.on)} onClick={c.flip}>
      {children}
    </button>
  )
}
// the argument is not a plain read: the helper keeps running in a job
function RNeg({ children, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const c = useContext(M)
  return (
    <button type="button" {...rest} data-state={getState(!c.on)} onClick={c.flip}>
      {children}
    </button>
  )
}
export function Outer({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <RProvider>
      <RTrigger {...rest}>go</RTrigger>
    </RProvider>
  )
}
export function OuterNeg({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <RProvider>
      <RNeg {...rest}>go</RNeg>
    </RProvider>
  )
}
