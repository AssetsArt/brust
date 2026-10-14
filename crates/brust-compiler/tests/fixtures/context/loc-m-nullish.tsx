import { createContext } from 'react'

const el = <b>hi</b>

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
  return <Panel label="x">{undefined ?? el}</Panel>
}
