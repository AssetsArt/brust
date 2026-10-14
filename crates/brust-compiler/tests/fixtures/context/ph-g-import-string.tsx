import { createContext } from 'react'
import { String } from './lib/shadow'
const Ctx = createContext<{ label: string }>({ label: 'd' })
function tag(v: string) { return String(v) }

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{tag(label)}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
