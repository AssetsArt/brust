import { createContext, useContext } from 'react'

const Nested = createContext({ a: { x: 'deep' }, b: 2 })

// F431: a field whose default is not a plain value (a nested object) keeps the fallback by name (context-no-provider).
export default function NestedPage() {
  const v = useContext(Nested)
  return (
    <main>
      <p data-testid="a">{v.a.x}</p>
      <p data-testid="b">{v.b}</p>
    </main>
  )
}
