import { useState } from 'react'
import Pr from './Pr'

export default function Page() {
  const [c, setC] = useState(0)
  const [swapped, setSwapped] = useState(false)
  return (
    <main>
      <Pr data-testid="pr" onMouseDown={swapped ? () => setC(c + 100) : () => setC(c + 1)}>
        press
      </Pr>
      <output data-testid="count">{c}</output>
      <button data-testid="swap" onClick={() => setSwapped(true)}>
        swap
      </button>
    </main>
  )
}
