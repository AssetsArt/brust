import * as React from 'react'
import { createContext, useContext, useEffect, useState } from 'react'

// Radix's SwitchTrigger: fields destructured from a context, read in code printed as written (a composed handler, an
// effect): they print as the hidden props the chunk binds around that code.
const V = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })
function compose<E>(a: ((e: E) => void) | undefined, b: (e: E) => void) {
  return (e: E) => {
    a?.(e)
    b(e)
  }
}
function VProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <V.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</V.Provider>
}
function VTrigger({ onClick }: { onClick?: (e: unknown) => void }) {
  const { on, flip } = useContext(V)
  useEffect(() => {
    document.title = on ? 'on' : 'off'
  }, [on])
  return <button aria-pressed={on} onClick={compose(onClick, () => flip())} />
}
export default function Page() {
  return (
    <main>
      <VProvider>
        <VTrigger />
      </VProvider>
    </main>
  )
}
