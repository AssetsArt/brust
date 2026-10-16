import { createContext, useContext, useState } from 'react'

// F304 (c): a Provider value whose methods read `this`, or a class instance, is not an object of closures
const A = createContext<{ open: boolean; get: () => boolean }>({ open: false, get: () => false })

export function TP({ children }: { children?: React.ReactNode }) {
  const [open] = useState(false)
  return (
    <A.Provider
      value={{
        open,
        get() {
          return this.open
        },
      }}
    >
      <div>{children}</div>
    </A.Provider>
  )
}
export function TC({ children }: { children?: React.ReactNode }) {
  const c = useContext(A)
  return <button onClick={() => { document.title = String(c.get()) }}>{children}</button>
}

class Store {
  constructor(public open: boolean) {}
  get() {
    return this.open
  }
}
const B = createContext<Store>(new Store(false))
export function KP({ children }: { children?: React.ReactNode }) {
  const [open] = useState(false)
  return (
    <B.Provider value={new Store(open)}>
      <div>{children}</div>
    </B.Provider>
  )
}
export function KC({ children }: { children?: React.ReactNode }) {
  const c = useContext(B)
  return <button onClick={() => { document.title = String(c.get()) }}>{children}</button>
}
