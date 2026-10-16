import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
// F194: the same leak through a const arrow helper.
const tag = (x: string) => {
  {
    const globalThis = x
  }
  return globalThis
}

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
