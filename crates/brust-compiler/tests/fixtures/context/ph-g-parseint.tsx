import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
function parseInt(v: string) { return <b>{v}</b> }
function tag(v: string) { return parseInt(v) }

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
