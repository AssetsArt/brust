// F362 PR2 (Mellow, review round 1): the data module is still in the client graph through another importer (reader.ts),
// so the build's probe sees it and the chunk imports the list as written (one instance, as before PR2).
import { useState } from 'react'
import { ITEMS } from './data_shared'
import { countOf } from './reader'
export default function Page() {
  const [sel, setSel] = useState(0)
  const [count, setCount] = useState(0)
  return (
    <main>
      <button type="button" data-testid="count" onClick={() => setCount(countOf())}>count</button>
      <p data-sel={sel}>{count}</p>
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
