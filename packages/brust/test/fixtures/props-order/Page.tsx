import { useState } from 'react'
import IslandBox from './IslandBox'

export default function Page() {
  const [n, setN] = useState(0)
  return (
    <main>
      <button data-testid="bump" onClick={() => setN(n + 1)}>
        {n}
      </button>
      <IslandBox style={{ marginTop: 5, margin: 0, color: 'red' }} cfg={{ z: 1, a: { y: 2, b: 3 }, m: [{ q: 1, c: 2 }] }} />
    </main>
  )
}
