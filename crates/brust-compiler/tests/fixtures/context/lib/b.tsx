import { createContext, useContext } from 'react'

// B's own context object, which happens to share A's local name.
const Ctx = createContext<{ ok: string }>({ ok: 'B-default' })

export function BadgeB() {
  const c = useContext(Ctx)
  return <b>{c.ok}</b>
}
