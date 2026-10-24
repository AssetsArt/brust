import { createContext, useContext } from 'react'

const Ctx = createContext({ a: 'dflt', b: 2, on: false })

// F431: the page reads fields of an object-default context with no Provider: each is the field's literal default.
export default function FieldPage() {
  const v = useContext(Ctx)
  return (
    <main>
      <p data-testid="a">{v.a}</p>
      <p data-testid="b">{v.b}</p>
      <p data-testid="on">{v.on ? 'on' : 'off'}</p>
    </main>
  )
}
