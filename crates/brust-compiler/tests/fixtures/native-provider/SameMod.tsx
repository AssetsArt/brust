import * as React from 'react'
import { createContext, useContext, useState } from 'react'

// Radix's shape: the Provider, its consumer and the component that renders both live in ONE module (`Switch`)
const M = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })

function SProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <M.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</M.Provider>
}
function STrigger({ label }: { label: string }) {
  const c = useContext(M)
  return <button aria-pressed={c.on} onClick={c.flip}>{label}</button>
}
function SNote() {
  return <i>note</i>
}
export function Outer({ label }: { label: string }) {
  return (
    <SProvider>
      <STrigger label={label} />
      <SNote />
    </SProvider>
  )
}
