import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
const list = [<b>hi</b>]

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
