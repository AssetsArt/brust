import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// The Provider renders its content under its own condition: the consumer's host element is switched by the PROVIDER's
// `open`, which a directive on the consumer's own host could not reach (it would bind by the consumer's instance).
const GateCtx = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} })

export function Gate({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <GateCtx.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>
      <section>
        <button type="button" data-testid="own" onClick={() => setOpen((o) => !o)}>
          own
        </button>
        {open && <>{children}</>}
      </section>
    </GateCtx.Provider>
  )
}

export function GateButton({ children }: { children?: React.ReactNode }) {
  const c = useContext(GateCtx)
  return (
    <button type="button" aria-pressed={c.open} onClick={c.toggle}>
      {children}
    </button>
  )
}
