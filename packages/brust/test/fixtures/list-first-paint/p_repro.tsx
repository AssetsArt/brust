import { useState } from 'react'

// The filed B-10 repro: the shown row is picked by the row index, and the third row is shown first.
const ROWS = [{ name: 'read' }, { name: 'write' }, { name: 'openat' }]
export default function PRepro() {
  const [pick, setPick] = useState(2)
  return (
    <main>
      <button type="button" data-testid="first" onClick={() => setPick(0)}>
        first
      </button>
      {ROWS.map((r, k) => (
        <p key={r.name} hidden={pick !== k}>
          {r.name}
        </p>
      ))}
    </main>
  )
}
