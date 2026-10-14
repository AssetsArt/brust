import { createContext, useContext } from 'react'
import { el } from './ctxlib/els'

function makeIcon() {
  return el
}

const Ctx = createContext<{ icon: React.ReactNode } | null>(null)

function Panel({ children }: { children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ icon: makeIcon() }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

function Badge() {
  const c = useContext(Ctx)!
  return <i>{c.icon}</i>
}

export default function Page() {
  return (
    <Panel>
      <Badge />
    </Panel>
  )
}
