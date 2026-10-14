import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
const el = <b>hi</b>

function Panel({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{children}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x">{el}</Panel>
}
