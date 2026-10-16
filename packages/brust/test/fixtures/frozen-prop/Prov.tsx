import { createContext, useState } from 'react'
const A = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} })
// A Provider whose value is state (R34.122: specialised per call site with the caller's content).
export function P({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <A.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>
      <div data-testid="box" data-open={open ? 'y' : 'n'} onClick={() => setOpen((o) => !o)}>{children}</div>
    </A.Provider>
  )
}
