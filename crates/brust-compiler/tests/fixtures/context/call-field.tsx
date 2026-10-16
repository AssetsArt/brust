import { createContext, useContext } from 'react'

const Ctx = createContext<{ pct: number } | null>(null)

function clamp(v: number) {
  return Math.min(Math.max(v, 0), 100)
}

function Meter({ value = 0, children }: { value?: number; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ pct: clamp(value) }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Fill() {
  const c = useContext(Ctx)!
  return <i>{c.pct}</i>
}

export default function Page() {
  return (
    <Meter value={150}>
      <Fill />
    </Meter>
  )
}
