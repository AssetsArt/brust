import { createContext, useContext, useState } from 'react'
// Radix Switch's shape: a state Provider calls its render prop with a local object that also holds a setter.
const C = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })
export function RCS({ children, render }: { children?: React.ReactNode; render?: (c: { on: boolean }) => React.ReactNode }) {
  const [on, setOn] = useState(false)
  const ctx = { on, setOn }
  return <C.Provider value={{ on, flip: () => setOn((o) => !o) }}>{typeof render === 'function' ? render(ctx) : children}</C.Provider>
}
export function RT({ children }: { children?: React.ReactNode }) {
  const c = useContext(C)
  return (
    <button type="button" data-testid="box" data-on={c.on ? 'y' : 'n'} onClick={c.flip}>
      {children}
    </button>
  )
}
