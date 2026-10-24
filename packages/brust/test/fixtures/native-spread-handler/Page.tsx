import { useState } from 'react'
import Field from './Field'
import Pr from './Pr'

export default function Page() {
  const [c, setC] = useState(0)
  const [swapped, setSwapped] = useState(false)
  const [typed, setTyped] = useState('')
  return (
    <main>
      <Pr data-testid="pr" onMouseDown={swapped ? () => setC(c + 100) : () => setC(c + 1)}>
        press
      </Pr>
      <output data-testid="count">{c}</output>
      <Field data-testid="field" onChange={(e: any) => setTyped(e.target.value)} />
      <output data-testid="typed">{typed}</output>
      <button data-testid="swap" onClick={() => setSwapped(true)}>
        swap
      </button>
    </main>
  )
}
