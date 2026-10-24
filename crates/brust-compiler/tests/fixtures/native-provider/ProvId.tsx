import * as React from 'react'

const Ctx = React.createContext({ base: '', open: false })

// A state Provider whose frame hands out a derived template over a useId value (Radix's `baseId`, `radix-${id}`).
export function PI({ children }: { children?: React.ReactNode }) {
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const base = `p-${id}`
  return (
    <Ctx.Provider value={{ base, open }}>
      <button type="button" onClick={() => setOpen(!open)}>t</button>
      {children}
    </Ctx.Provider>
  )
}

export function PIConsumer() {
  const { base, open } = React.useContext(Ctx)
  return <span id={base}>{open ? 'y' : 'n'}</span>
}
