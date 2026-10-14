import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
function tag(String: (v: string) => unknown, v: string) { return String(v) }

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{tag(label, label)}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
