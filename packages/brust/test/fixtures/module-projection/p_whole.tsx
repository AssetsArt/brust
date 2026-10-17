// F362 (C1): the row value is handed on whole (a handler argument): the list ships as written.
import { useState } from 'react'
const ITEMS = [
  { id: 1, name: 'one', secret: 'SECRET_A' },
  { id: 2, name: 'two', secret: 'SECRET_B' },
  { id: 3, name: 'three', secret: 'SECRET_C' },
]
export default function Page() {
  const [sel, setSel] = useState<unknown>(null)
  return (
    <main>
      <p data-sel={sel === null ? 'none' : 'set'}>{sel === null ? '-' : 'picked'}</p>
      <ul>
        {ITEMS.map((it) => (
          <li key={it.id} data-testid={`r${it.id}`} onClick={() => setSel(it)}>
            {it.name}
          </li>
        ))}
      </ul>
    </main>
  )
}
