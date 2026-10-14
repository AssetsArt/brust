import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
const icons = { home: <b>hi</b> }

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
