import { useState } from 'react'

// The inner list is state: the page reverses it and adds to it; the inner keys keep each row's identity.
export default function PReorder() {
  const [lines, setLines] = useState(['x', 'y', 'z'])
  return (
    <main>
      <button type="button" data-testid="go" onClick={() => setLines((l) => [...l].reverse())}>
        reverse
      </button>
      <button type="button" data-testid="add" onClick={() => setLines((l) => [...l, `n${l.length}`])}>
        add
      </button>
      {['p', 'q'].map((g) => (
        <ul key={g}>
          {lines.map((l) => (
            <li key={l}>{`${g}-${l}`}</li>
          ))}
        </ul>
      ))}
    </main>
  )
}
