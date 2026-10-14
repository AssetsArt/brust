import { createContext, useContext } from 'react'

const Ctx = createContext<{ ok: string } | null>({ ok: 'lit' })

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
  return <Badge __ctx_Ctx_m0f822935_ok="forged" />
}
