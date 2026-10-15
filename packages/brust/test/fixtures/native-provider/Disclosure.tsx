import * as React from 'react'
import { createContext, useContext, useId, useState } from 'react'

// A hand-written disclosure in the shape of Radix's collapsible: a Provider component with state, a toggle handler and a
// `useId`, handing them to the consumers rendered inside it (2c-2: a native Provider).
const Ctx = createContext<{ open: boolean; toggle: () => void; id: string }>({ open: false, toggle: () => {}, id: '' })

export function Disclosure({ children, defaultOpen = false }: { children?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <Ctx.Provider value={{ open, toggle: () => setOpen((o) => !o), id }}>
      <div data-state={open ? 'open' : 'closed'}>{children}</div>
    </Ctx.Provider>
  )
}

export function DisclosureTrigger({ children }: { children?: React.ReactNode }) {
  const c = useContext(Ctx)
  return (
    <button type="button" aria-expanded={c.open} aria-controls={c.id} onClick={c.toggle}>
      {children}
    </button>
  )
}

export function DisclosureContent({ children }: { children?: React.ReactNode }) {
  const c = useContext(Ctx)
  return c.open ? <div id={c.id}>{children}</div> : null
}

// The same shape without `useId`: instances nest (a fed child inside another fed component is a limit of the server's
// instance feeding, so the nested proof uses a Provider with no ids).
const PanelCtx = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} })

export function Panel({ children, defaultOpen = false }: { children?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <PanelCtx.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>
      <section data-panel={open ? 'open' : 'closed'}>{children}</section>
    </PanelCtx.Provider>
  )
}

export function PanelTrigger({ children }: { children?: React.ReactNode }) {
  const c = useContext(PanelCtx)
  return (
    <button type="button" aria-expanded={c.open} onClick={c.toggle}>
      {children}
    </button>
  )
}

export function PanelContent({ children }: { children?: React.ReactNode }) {
  const c = useContext(PanelCtx)
  return c.open ? <div>{children}</div> : null
}
