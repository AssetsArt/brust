import { createContext } from 'react'

export const Ctx = createContext<{ ok: string }>({ ok: 'A-default' })

export function PanelA({ children }: { children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ ok: 'from-A' }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}
