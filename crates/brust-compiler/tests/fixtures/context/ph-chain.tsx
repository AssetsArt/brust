import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
function el() { return <i>x</i> }
function mid(v: string) { return v ? el() : 'n' }

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{mid(label)}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
