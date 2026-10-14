import { createContext, useContext } from 'react'

const Ctx = createContext<{ ok: string } | null>(null)

function Panel({ children }: { children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ ok: 'lit' }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

function Badge() {
  const c = useContext(Ctx)!
  return <i>{c.ok}</i>
}

export default function Page() {
  return (
    <Panel>
      <Badge __ctx_Ctx_m8e03998d_ok="forged" />
    </Panel>
  )
}
