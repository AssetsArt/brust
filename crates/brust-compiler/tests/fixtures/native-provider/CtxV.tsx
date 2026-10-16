import * as React from 'react'
import { createContext, useContext, useEffect, useState } from 'react'

// F304: a Provider whose value is an object of closures (no class, no `this`), and consumers that read it in code printed as written
const A = createContext<{ open: boolean; toggle: () => void; label: string }>({ open: false, toggle: () => {}, label: '' })

export function CP({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <A.Provider value={{ open, toggle: () => setOpen((o) => !o), label: 'lbl' }}>
      <div data-open={open ? 'y' : 'n'}>{children}</div>
    </A.Provider>
  )
}

// positive: a handler calls a field and reads another; `c?.f` and a call through the optional chain
export function CHandler() {
  const c = useContext(A)
  return (
    <button
      onClick={() => {
        c.toggle()
        document.title = c.label + String(c?.open)
      }}
    >
      go
    </button>
  )
}
// positive: an effect reads a field (and depends on it)
export function CEffect() {
  const c = useContext(A)
  useEffect(() => {
    document.title = c.open ? 'y' : 'n'
  }, [c.open])
  return <p>e</p>
}
// negative: computed key (a string literal key reads like the member, and qualifies), destructure, whole value, write through a field, delete, prototype names
export function CComputed() {
  const c = useContext(A)
  return <button onClick={() => { const k = String(Date.now()); document.title = String((c as any)[k]) }}>x</button>
}
export function CDestruct() {
  const c = useContext(A)
  return <button onClick={() => { const { open } = c; document.title = String(open) }}>x</button>
}
export function CWhole() {
  const c = useContext(A)
  return <button onClick={() => { console.log(c) }}>x</button>
}
export function CWrite() {
  const c = useContext(A)
  return <button onClick={() => { (c.open as any).x = 1 }}>x</button>
}
export function CDelete() {
  const c = useContext(A)
  return <button onClick={() => { delete (c as any).label }}>x</button>
}
export function CProto() {
  const c = useContext(A)
  return <button onClick={() => { document.title = String((c as any).constructor) }}>x</button>
}
