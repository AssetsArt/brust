// F362 PR2 (Mellow, review round 1, probe j_store2): a list another client module pushes into. The build refuses the
// page by name (F230 module-written: React renders it), so re-created rows show the pushed item as React does.
import { useState } from 'react'
import { addItem } from './adder'
import { ITEMS } from './data_store'
export default function Page() {
  const [open, setOpen] = useState(true)
  return (
    <main>
      <button type="button" data-testid="add" onClick={() => addItem()}>add</button>
      <button type="button" data-testid="open" onClick={() => setOpen(!open)}>open</button>
      {open && (
        <ul>
          {ITEMS.map((it) => (
            <li key={it.id} data-id={it.id}>
              {it.name}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
