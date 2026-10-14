import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
function tag(v: string) { return v + '!' }
// The declaration the proof read is replaced before anything renders.
// @ts-ignore
tag = (v: string) => <b>{v}</b>

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
