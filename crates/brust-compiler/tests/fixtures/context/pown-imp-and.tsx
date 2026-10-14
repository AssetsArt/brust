import { createContext } from 'react'
import { el } from './lib/els'

const Ctx = createContext<{ label: string }>({ label: 'd' })

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{label && el}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
