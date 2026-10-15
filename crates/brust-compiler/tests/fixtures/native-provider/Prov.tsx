import * as React from 'react'
import { createContext, useContext, useState } from 'react'

const A = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} })
const B = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })

export function P({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <A.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>
      <div data-open={open ? 'y' : 'n'}>{children}</div>
    </A.Provider>
  )
}
export function PTrigger({ children }: { children?: React.ReactNode }) {
  const c = useContext(A)
  return <button aria-expanded={c.open} onClick={c.toggle}>{children}</button>
}
export function PBody({ children }: { children?: React.ReactNode }) {
  const c = useContext(A)
  return c.open ? <div>{children}</div> : null
}
export function PEffect({ children }: { children?: React.ReactNode }) {
  const c = useContext(A)
  const r = React.useRef<HTMLParagraphElement>(null)
  React.useEffect(() => { if (r.current) r.current.dataset.seen = c.open ? 'y' : 'n' }, [c.open])
  return <p ref={r}>{children}</p>
}

export function Q({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return (
    <B.Provider value={{ on, flip: () => setOn((o) => !o) }}>
      <section data-on={on ? 'y' : 'n'}>{children}</section>
    </B.Provider>
  )
}
export function QTrigger({ children }: { children?: React.ReactNode }) {
  const c = useContext(B)
  return <button aria-pressed={c.on} onClick={c.flip}>{children}</button>
}

// reads its children as a value: only the markup of the children can be moved
export function Gated({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <A.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>
      <div>{open ? children : null}</div>
    </A.Provider>
  )
}
