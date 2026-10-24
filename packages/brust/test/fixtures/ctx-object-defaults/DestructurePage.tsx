import { createContext, useContext, useState } from 'react'

const Ctx = createContext({ a: 'dflt', b: 2, on: false })

function Show() {
  const { a, b } = useContext(Ctx)
  return <p data-testid="child">{a}-{b}</p>
}

// F431: destructured by the page and by a child it renders, next to state of its own.
export default function DestructurePage() {
  const { a, b } = useContext(Ctx)
  const [n, setN] = useState(0)
  return (
    <main>
      <p data-testid="own">{a}-{b}</p>
      <Show />
      <button type="button" data-testid="inc" onClick={() => setN(n + 1)}>{n}</button>
    </main>
  )
}
