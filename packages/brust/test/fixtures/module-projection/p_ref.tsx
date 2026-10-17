// F362 (Afrojack, PR1 review): a ref's initial value reads the list on the client; shown by a click, it must be the
// list's own value, so the list ships as written.
import { useRef, useState } from 'react'
const ITEMS = [
  { id: 1, name: 'one', secret: 'SECRET_A' },
  { id: 2, name: 'two', secret: 'SECRET_B' },
  { id: 3, name: 'three', secret: 'SECRET_C' },
]
export default function Page() {
  const [sel, setSel] = useState(0)
  const [shown, setShown] = useState('-')
  const first = useRef(ITEMS[0]?.secret)
  return (
    <main>
      <button type="button" data-testid="show" onClick={() => setShown(String(first.current))}>show</button>
      <p data-sel={sel}>{shown}</p>
      <ul>
        {ITEMS.map((it) => (
          <li key={it.id} data-testid={`r${it.id}`} data-on={sel === it.id ? 1 : 0} onClick={() => setSel(it.id)}>
            {it.name}
          </li>
        ))}
      </ul>
    </main>
  )
}
