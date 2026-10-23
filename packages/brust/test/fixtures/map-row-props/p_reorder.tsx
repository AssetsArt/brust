import { useState } from 'react'
import Label from './Label'

// Keyed rows over state that the page reorders: each row's child must keep following its own row item.
export default function PReorder() {
  const [rows, setRows] = useState([
    { id: 'x', a: 'one' },
    { id: 'y', a: 'two' },
    { id: 'z', a: 'three' },
  ])
  return (
    <main>
      <button type="button" data-testid="go" onClick={() => setRows((r) => [...r].reverse())}>
        reverse
      </button>
      <button type="button" data-testid="add" onClick={() => setRows((r) => [...r, { id: `n${r.length}`, a: `new${r.length}` }])}>
        add
      </button>
      <p>
        {rows.map((r) => (
          <span key={r.id}>
            <Label text={{ a: r.a }} />
          </span>
        ))}
      </p>
    </main>
  )
}
