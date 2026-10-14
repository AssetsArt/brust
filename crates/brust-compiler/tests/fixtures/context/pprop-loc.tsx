import { createContext } from 'react'
const el = <b>hi</b>

const Ctx = createContext<{ label: string }>({ label: 'd' })

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section data-l={label}>{children}</section>
    </Ctx.Provider>
  )
}

function Badge({ icon }: { icon?: React.ReactNode }) {
  return <i>{icon}</i>
}

export default function Page() {
  return (
    <Panel label="x">
      <Badge icon={el} />
    </Panel>
  )
}
