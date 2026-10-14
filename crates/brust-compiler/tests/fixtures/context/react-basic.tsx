import { createContext, useContext } from 'react'

const Ctx = createContext<{ title: string; shout: string } | null>(null)

function Panel({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ title, shout: title + '!' }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

function Badge() {
  const c = useContext(Ctx)!
  return <b data-t={c.title}>{c.shout}</b>
}

export default function Page() {
  return (
    <Panel title="hi">
      <Badge />
    </Panel>
  )
}
