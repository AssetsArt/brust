import { createContext, useContext, useState } from 'react'
// A state Provider (specialised per call site, R34.122) and a consumer that prints its children in its own host.
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
  return <button type="button" data-testid="box" data-open={c.open ? 'y' : 'n'} onClick={c.toggle}>{children}</button>
}
