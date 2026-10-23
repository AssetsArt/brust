import { useState } from 'react'

// A list that starts empty: the server prints only its zero-row template, and rows the page adds come from it.
export default function PEmpty() {
  const [rows, setRows] = useState<{ name: string }[]>([])
  return (
    <main>
      <button type="button" data-testid="add" onClick={() => setRows((r) => [...r, { name: `row${r.length}` }])}>
        add
      </button>
      {rows.map((r, k) => (
        <p key={r.name} hidden={k !== rows.length - 1}>
          {r.name}
        </p>
      ))}
    </main>
  )
}
