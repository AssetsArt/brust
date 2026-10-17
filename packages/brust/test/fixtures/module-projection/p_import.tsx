// F362 PR2: the rows of p_rows over a list imported from a data module: the chunk declares it projected, the module is not bundled.
import { useState } from 'react'
import { ITEMS } from './data'
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
