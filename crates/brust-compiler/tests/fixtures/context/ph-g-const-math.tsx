import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
const Math = { round: (n: number) => <b>{n}</b> }
function tag(n: number) { return Math.round(n) }

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{tag(1.5)}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
