import { useState } from 'react'
import { Outer } from './RestHlp'

export default function RestLivePage() {
  const [n, setN] = useState(0)
  return (
    <main>
      <button onClick={() => setN(n + 1)}>inc</button>
      <Outer data-n={n} />
    </main>
  )
}
