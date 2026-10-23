import { createContext, useContext, useState } from 'react'

// F384: `{cond && children}` / `{cond ? children : null}` in a component that receives children, plainly and inside a
// specialised Provider clone (Radix CollapsibleContentImpl's `{isOpen && children}`).
export const Open = createContext(false)

export function Prov({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Open.Provider value={open}>
      <button type="button" data-testid="prov-toggle" onClick={() => setOpen(!open)}>
        t
      </button>
      {children}
    </Open.Provider>
  )
}

export function Panel({ children }: { children?: React.ReactNode }) {
  const open = useContext(Open)
  return (
    <section data-testid="panel" data-open={open ? 'y' : 'n'}>
      {open && children}
    </section>
  )
}

export function PanelTernary({ children }: { children?: React.ReactNode }) {
  const open = useContext(Open)
  return <section data-testid="ternary">{open ? children : null}</section>
}

export function Plain(props: { open: boolean; children?: React.ReactNode }) {
  return <div data-testid="plain">{props.open && props.children}</div>
}
