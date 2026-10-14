import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
function tag(v: string) { return { v } }

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
