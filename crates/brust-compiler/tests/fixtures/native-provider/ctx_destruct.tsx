import { createContext, useContext, useState } from 'react'

const M = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })

function SProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <M.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</M.Provider>
}
// the context local is destructured in the body, and aliased
function STrigger() {
  const context = useContext(M)
  const { on, flip } = context
  const again = context
  return (
    <button aria-pressed={on} data-same={again.on} onClick={flip}>
      go
    </button>
  )
}
export default function P() {
  return (
    <SProvider>
      <STrigger />
    </SProvider>
  )
}
