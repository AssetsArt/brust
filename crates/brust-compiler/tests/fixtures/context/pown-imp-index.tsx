import { createContext } from 'react'
import { list } from './lib/els'

const Ctx = createContext<{ label: string }>({ label: 'd' })

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{list[0]}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
