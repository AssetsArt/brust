import { useState } from 'react'
import { api } from './api'
import Card from './Card'

type Row = { id: string; label: string }

// Case 4: rows drawn on the client from an action's data held in state; the server may print zero rows.
export default function Board({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initial)
  const fill = async () => {
    const r = await api.rows.get()
    if (r.data) setRows(r.data.rows)
  }
  return (
    <section id="board">
      <button type="button" id="fill" onClick={fill}>
        fill
      </button>
      <button type="button" id="empty" onClick={() => setRows([])}>
        empty
      </button>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <Card id={r.id} label={r.label} />
          </li>
        ))}
      </ul>
    </section>
  )
}
