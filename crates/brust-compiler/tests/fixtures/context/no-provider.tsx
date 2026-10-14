import { createContext, useContext } from 'react'

const Ctx = createContext<{ n: number } | null>(null)

function Leaf() {
  const c = useContext(Ctx)!
  return <b>{c.n}</b>
}

export default function Page() {
  return <Leaf />
}
