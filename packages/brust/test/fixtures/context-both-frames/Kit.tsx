import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// F317: the F298 shape (Root spreads its rest, with the page's Thumb in it, under its OWN Provider of K) with a SECOND Provider of the
// same context around the call site, in the page. React resolves the Thumb against the inner one (Root's), the Outer reader against the outer.
export const K = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })

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

// Reads the Provider the page wrote around Root, not Root's own.
export function Outer() {
  const c = useContext(K)
  return <b data-testid="outer-reader" data-state={c.on ? 'checked' : 'unchecked'} />
}

// The page's own frame of K, written as a Provider component (a relative member tag `K.Provider` is not resolved).
export function OuterFrame({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(true)
  return <K.Provider value={{ on, flip: () => setOn((v) => !v) }}>{children}</K.Provider>
}
export function OuterFlip() {
  const c = useContext(K)
  return (
    <button type="button" data-testid="outer-flip" onClick={c.flip}>
      outer
    </button>
  )
}
