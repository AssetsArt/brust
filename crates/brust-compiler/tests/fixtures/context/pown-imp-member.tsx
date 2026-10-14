import { createContext } from 'react'
import { icons } from './lib/els'

const Ctx = createContext<{ label: string }>({ label: 'd' })

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{icons.home}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
