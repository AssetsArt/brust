import { createContext, useContext, useState } from 'react'
const A = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} })
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
  return <button type="button" data-open={c.open ? 'y' : 'n'} onClick={c.toggle}>{children}</button>
}
