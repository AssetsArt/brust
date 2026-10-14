import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
const el = <b>hi</b>

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{el}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
