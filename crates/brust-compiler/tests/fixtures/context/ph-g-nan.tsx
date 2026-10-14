import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
const NaN = <b>x</b>
function tag() { return NaN }

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{tag()}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
