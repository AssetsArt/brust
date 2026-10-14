import { createContext } from 'react'

const Ctx = createContext<{ label: string }>({ label: 'd' })
const LIMIT = 3
function isNum(v: any) { return typeof v === 'number' }
function tag(v: string, n: number) { if (!isNum(n)) return 'none'; return `${v}:${Math.round(n)}/${LIMIT}` }

function Panel({ label }: { label: string }) {
  return (
    <Ctx.Provider value={{ label }}>
      <section>{tag(label, 7)}</section>
    </Ctx.Provider>
  )
}

export default function Page() {
  return <Panel label="x" />
}
