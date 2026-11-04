import { useState } from 'react'
import { List, type Section } from './parts'

// The same List from a stateful parent: its rows change on the client, so it stays native (x-for).
export default function StatefulPage() {
  const [rows, setRows] = useState<Section[]>([{ id: 'a', type: 'hero', data: { title: 'A' } }])
  return (
    <main>
      <button type="button" onClick={() => setRows([...rows, { id: `n${rows.length}`, type: 'hero', data: { title: `N${rows.length}` } }])}>
        add
      </button>
      <List sections={rows} />
    </main>
  )
}
