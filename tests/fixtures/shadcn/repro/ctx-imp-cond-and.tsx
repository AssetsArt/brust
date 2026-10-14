import { createContext } from 'react'
import { el } from './ctxlib/els'

const Ctx = createContext<{ label: string }>({ label: 'd' })

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section data-l={label}>{children}</section>
    </Ctx.Provider>
  )
}

//  is always true here: React prints the element; the conditional child must not print nothing.
export default function Page() {
  const on = true
  return <Panel label="x">{on && el}</Panel>
}
