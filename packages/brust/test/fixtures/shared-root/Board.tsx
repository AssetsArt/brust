// Stateful parent: feeds List a state value, so List's rows must stay re-creatable on /b.
import { useState } from 'react'
import List from './List'

export default function Board(props: { items: { id: string; name: string }[] }) {
  const [items, setItems] = useState(props.items)
  return (
    <section>
      <button onClick={() => setItems(items.slice().reverse())}>reverse</button>
      <List items={items} />
    </section>
  )
}
