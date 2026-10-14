import { createContext } from 'react'
import { el } from './ctxlib/els'

const Ctx = createContext<{ label: string }>({ label: 'd' })

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  const on = true
  return <Panel label="x">{el}</Panel>
}
