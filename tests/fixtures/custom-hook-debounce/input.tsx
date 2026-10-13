import { useState } from 'react'
import { useDebounced } from './useDebounced'

// G3 (plan L5): a custom hook imported from a sibling module is inlined at the call site, so the
// search box stays native: `settled` becomes `settled_useDebounced1`, `value` reads the caller's `q`.
export default function Search({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial)
  const shown = useDebounced(q, 300)
  return (
    <div>
      <input id="q" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      <p id="shown">{shown}</p>
    </div>
  )
}
