import { useState } from 'react'

type Todo = { id: string; title: string; done: boolean }

export default function TodoList({ todos }: { todos: Todo[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <ul className="todos">
      {todos.map((todo, i) => (
        <li key={todo.id} className={todo.id === selected ? 'selected' : ''} onClick={() => setSelected(todo.id)}>
          {i + 1}. {todo.title}
          {todo.done && <span className="done">done</span>}
        </li>
      ))}
    </ul>
  )
}
