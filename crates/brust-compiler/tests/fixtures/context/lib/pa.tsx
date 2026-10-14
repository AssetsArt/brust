import { Ctx } from './shared'

export function PanelS({ children }: { children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ ok: 'from-S' }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}
