import { createContext, useContext } from 'react'

const MAX = 100

function clamp(v: number, max: number) {
  return Math.min(Math.max(v, 0), max)
}

function stateOf(v: number, max: number) {
  return v >= max ? 'complete' : 'loading'
}

const Ctx = createContext<{ pct: number; state: string } | null>(null)

export function Meter({ value = 0, max = MAX, children }: { value?: number; max?: number; children?: React.ReactNode }) {
  const pct = clamp(value, max)
  return (
    <Ctx.Provider value={{ pct, state: stateOf(pct, max) }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

export function Fill() {
  const c = useContext(Ctx)!
  return <i data-state={c.state}>{c.pct}</i>
}
