import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// F275: a frame field that is the negation of a module helper's result over state (the shape of Radix's `!isFormControl`).
const HCtx = createContext<{ free: boolean; grab: () => void }>({ free: true, grab: () => {} })

function held(grabbed: boolean) {
  return !!grabbed
}

export function HProvider({ children }: { children?: React.ReactNode }) {
  const [grabbed, setGrabbed] = useState(false)
  const free = !held(grabbed)
  return <HCtx.Provider value={{ free, grab: () => setGrabbed(true) }}>{children}</HCtx.Provider>
}

export function HTrigger() {
  const c = useContext(HCtx)
  return (
    <button type="button" data-free={c.free ? 'y' : 'n'} onClick={c.grab}>
      grab
    </button>
  )
}
