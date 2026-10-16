import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// F298: Radix's `Switch.Root` + `Switch.Thumb` shape in one module: the call site's children travel inside the rest the
// component spreads into a consumer under its Provider, so the consumer the call site passes as a child renders there.
const K = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })

function getState(on: boolean) {
  return on ? 'checked' : 'unchecked'
}

function KProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <K.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</K.Provider>
}
function KTrigger({ children, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  const c = useContext(K)
  return (
    <button type="button" {...rest} aria-pressed={c.on} data-state={getState(c.on)} onClick={c.flip}>
      {children}
    </button>
  )
}
// A trigger that reads nothing that changes (no context, handler, ref or effect): static and unlinked, so the children it
// prints are bound by the clone around it (a linked one would host them itself: slot-owner, F309).
function KLabel({ children, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <button type="button" {...rest}>
      {children}
    </button>
  )
}
export function KThumb() {
  const c = useContext(K)
  return <span data-state={getState(c.on)} />
}
export function KRoot({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <KProvider>
      <KTrigger {...rest} />
    </KProvider>
  )
}
export function KRootStatic({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <KProvider>
      <KLabel {...rest} />
    </KProvider>
  )
}
