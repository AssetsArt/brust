// F362: a module list the rows run over; `secret` is never read by the client.
import { useState } from 'react'
const ITEMS = [
  { id: 1, name: 'one', secret: 'SECRET_A' },
  { id: 2, name: 'two', secret: 'SECRET_B' },
  { id: 3, name: 'three', secret: 'SECRET_C' },
]
export default function Page() {
  const [sel, setSel] = useState(0)
  const [open, setOpen] = useState(true)
  return (
    <main>
      <button type="button" data-testid="open" onClick={() => setOpen(!open)}>open</button>
      <p data-sel={sel}>{sel}</p>
      {open && (
        <ul>
          {ITEMS.map((it) => (
            <li key={it.id} data-testid={`r${it.id}`} data-on={sel === it.id ? 1 : 0} onClick={() => setSel(it.id)}>
              {it.name}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
