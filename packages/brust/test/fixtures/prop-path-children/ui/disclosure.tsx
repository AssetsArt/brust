import { cloneElement, createContext, useContext, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

const Ctx = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} })

/** The root: owns the state, so it is the React island; the parts below are its children on the page. */
export function Disclosure({ label, children }: { label: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Ctx.Provider value={{ open, toggle: () => setOpen(!open) }}>
      <div data-testid={`disc-${label}`} data-state={open ? 'open' : 'closed'}>
        {children}
      </div>
    </Ctx.Provider>
  )
}

/** `asChild`: the child element receives the click handler (the Slot shape). */
export function Trigger({ asChild, children }: { asChild?: boolean; children?: ReactNode }) {
  const { toggle } = useContext(Ctx)
  if (asChild) return cloneElement(children as ReactElement<{ onClick?: () => void }>, { onClick: toggle })
  return (
    <button type="button" onClick={toggle}>
      {children}
    </button>
  )
}

export function Body({ children }: { children?: ReactNode }) {
  const { open } = useContext(Ctx)
  return open ? <div data-testid="body">{children}</div> : null
}
