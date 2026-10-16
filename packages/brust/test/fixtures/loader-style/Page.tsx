import { useState } from 'react'
import IslandBox from './IslandBox'

export default function Page({ box }: { box: { style: Record<string, any>; cfg: Record<string, any>; order: Record<string, string> } }) {
  const [n, setN] = useState(0)
  return (
    <main>
      <button data-testid="bump" onClick={() => setN(n + 1)}>
        {n}
      </button>
      <p data-testid="plain" style={box.style}>
        plain
      </p>
      <p data-testid="spread" style={{ ...box.style, position: 'absolute' }}>
        spread
      </p>
      <ul data-testid="list">
        {Object.entries(box.order).map((e) => (
          <li key={e[0]}>
            {e[0]}={e[1]}
          </li>
        ))}
      </ul>
      <IslandBox style={box.style} cfg={box.cfg} />
    </main>
  )
}
