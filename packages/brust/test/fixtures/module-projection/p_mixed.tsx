// F362 PR2 (Afrojack): the list and another export from one module: the module stays imported for `pick` (a function
// does not fold), so the build imports the list as written too. (A constant other export folds and leaves no import.)
import { useState } from 'react'
import { ITEMS, pick } from './data_mixed'
export default function Page() {
  const [sel, setSel] = useState(0)
  return (
    <main>
      <p data-sel={sel}>{sel}</p>
      <ul>
        {ITEMS.map((it) => (
          <li key={it.id} data-testid={`r${it.id}`} data-on={sel === it.id ? 1 : 0} onClick={() => setSel(pick(it.id))}>
            {it.name}
          </li>
        ))}
      </ul>
    </main>
  )
}
