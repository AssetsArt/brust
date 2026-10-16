import { createContext, useContext, useState } from 'react'
// S2: a state Provider (specialised per call site) whose value is its state only; its own button toggles it.
const O = createContext<{ open: boolean }>({ open: false })
export function PO({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <O.Provider value={{ open }}>
      <button type="button" data-testid="t" onClick={() => setOpen(!open)}>t</button>
      <div data-open={open ? 'y' : 'n'}>{children}</div>
    </O.Provider>
  )
}
export function OShow() {
  const c = useContext(O)
  return <i data-open={c.open ? 'y' : 'n'} />
}
