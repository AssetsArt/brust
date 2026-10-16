import * as React from 'react'
import { createContext, useContext, useState } from 'react'
import { Slot } from '@radix-ui/react-slot'

// The asChild consumer (Radix's CollapsibleTrigger shape): the Provider's toggle and state reach whatever element the
// caller passes as the child.
const PolyCtx = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} })

export function Poly({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <PolyCtx.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>
      <div data-poly={open ? 'open' : 'closed'}>{children}</div>
    </PolyCtx.Provider>
  )
}

export function PolyTrigger({ asChild, children }: { asChild?: boolean; children?: React.ReactNode }) {
  const c = useContext(PolyCtx)
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp type="button" aria-expanded={c.open} onClick={c.toggle}>
      {children}
    </Comp>
  )
}

export function PolyContent({ children }: { children?: React.ReactNode }) {
  const c = useContext(PolyCtx)
  return c.open ? <div>{children}</div> : null
}
