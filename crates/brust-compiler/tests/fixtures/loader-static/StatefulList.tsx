import { useState } from 'react'
import { List } from './List'
export default function StatefulList() {
  const [rows, setRows] = useState([{ id: 'a', type: 'hero', data: { title: 'A', price: '1' } }])
  return (
    <section>
      <button onClick={() => setRows([...rows, { id: String(rows.length), type: 'hero', data: { title: 'N', price: '2' } }])}>add</button>
      <List sections={rows} />
    </section>
  )
}
