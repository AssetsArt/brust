import { createContext, useContext, useTransition } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'default' })

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

function Badge() {
  const c = useContext(Ctx)
  return <b>{c.label}</b>
}

function Live() {
  const [, start] = useTransition()
  return <button type="button" onClick={() => start(() => {})}>go</button>
}

// The island sits BESIDE the Provider, not under it: the Provider still lowers.
export default function Page() {
  return (
    <div>
      <Panel label="from-panel">
        <Badge />
      </Panel>
      <Live />
    </div>
  )
}
