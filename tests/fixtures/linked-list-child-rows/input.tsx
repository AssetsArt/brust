import { useState } from 'react'
import List from './List'
// A stateless child whose own prop list holds static children: the parent re-creates `items`,
// so List's rows (and the Badge in each) must stay bound (review of F70, repro d8s).
export default function Page() {
  const [items, setItems] = useState([{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }])
  return (
    <div>
      <button onClick={() => setItems(items.concat([{ id: 'z', name: 'Zed' }]))}>add</button>
      <List rows={items} />
    </div>
  )
}
