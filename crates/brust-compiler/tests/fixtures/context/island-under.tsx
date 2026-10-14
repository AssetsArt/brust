import { createContext, useContext, useTransition } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'default' })

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

// Same module, interactive (useTransition): hydrates as an island, reads the context at run time.
function Live() {
  const c = useContext(Ctx)
  const [pending, start] = useTransition()
  return (
    <button type="button" onClick={() => start(() => {})}>
      {c.label}
      {pending ? '…' : ''}
    </button>
  )
}

export default function Page() {
  return (
    <Panel label="from-panel">
      <Live />
    </Panel>
  )
}
