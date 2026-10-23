import { useState } from 'react'

// Keyed rows over state, the shown one picked by index: reversing and adding after hydration keeps each row's text and
// moves `hidden` with the index, as React does.
export default function PReorder() {
  const [rows, setRows] = useState([{ name: 'read' }, { name: 'write' }, { name: 'openat' }])
  const [pick, setPick] = useState(2)
  return (
    <main>
      <button type="button" data-testid="reverse" onClick={() => setRows((r) => [...r].reverse())}>
        reverse
      </button>
      <button type="button" data-testid="add" onClick={() => setRows((r) => [...r, { name: `new${r.length}` }])}>
        add
      </button>
      <button type="button" data-testid="first" onClick={() => setPick(0)}>
        first
      </button>
      {rows.map((r, k) => (
        <p key={r.name} hidden={pick !== k}>
          {r.name}
        </p>
      ))}
    </main>
  )
}
