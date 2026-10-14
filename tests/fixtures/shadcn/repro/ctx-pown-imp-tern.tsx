import { createContext } from 'react'
import { el } from './ctxlib/els'

const Ctx = createContext<{ label: string }>({ label: 'd' })

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{label ? el : null}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
