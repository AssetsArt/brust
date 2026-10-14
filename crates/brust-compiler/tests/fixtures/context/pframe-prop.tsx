import { createContext, useContext } from 'react'
import { el } from './lib/els'

const Ctx = createContext<{ icon: React.ReactNode } | null>(null)

function PanelP({ icon, children }: { icon?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ icon }}>
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
    <PanelP icon={el}>
      <Badge />
    </PanelP>
  )
}
