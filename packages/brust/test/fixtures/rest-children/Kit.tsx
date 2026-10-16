import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// F298: Radix's `Switch.Root` + `Switch.Thumb` shape: the page's children travel inside the rest that Root spreads into
// a label under its own Provider, so the Thumb the page passes reads that Provider (a separate flip button changes it).
const K = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })

function KProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <K.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</K.Provider>
}
function Flip() {
  const c = useContext(K)
  return (
    <button type="button" data-testid="flip" onClick={c.flip}>
      flip
    </button>
  )
}
// Reads nothing that changes: static and unlinked, so the Thumb it prints is bound by the Provider's clone around it.
function Label({ children, ...rest }: React.ComponentPropsWithoutRef<'span'>) {
  return <span {...rest}>{children}</span>
}
export function Thumb() {
  const c = useContext(K)
  return <i data-testid="thumb" data-state={c.on ? 'checked' : 'unchecked'} />
}
export function Root({ ...rest }: React.ComponentPropsWithoutRef<'span'>) {
  return (
    <KProvider>
      <Flip />
      <Label {...rest} />
    </KProvider>
  )
}
