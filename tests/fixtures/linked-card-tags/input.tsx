import { useState } from 'react'
import Card from './Card'
// A linked static child with its own prop list of static children inside a state-sourced row:
// a client-added row must paint ITS tags, not the template row's (review of F70, repro d8t).
export default function Page() {
  const [items, setItems] = useState([{ id: 'a', name: 'Ada', tags: ['x'] }, { id: 'b', name: 'Bob', tags: ['y', 'z'] }])
  return (
    <div>
      <button onClick={() => setItems(items.concat([{ id: 'z', name: 'Zed', tags: ['p', 'q'] }]))}>add</button>
      {items.map((r) => <Card key={r.id} name={r.name} tags={r.tags} />)}
    </div>
  )
}
