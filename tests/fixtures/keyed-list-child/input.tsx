import { useState } from 'react'
import Row from './Row'
export default function TodoList(props: { todos: { id: string; title: string }[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <ul className="todos">
      {props.todos.map((t) => (
        <Row key={t.id} title={t.title} selected={t.id === selected} onPick={() => setSelected(t.id)} />
      ))}
    </ul>
  )
}
