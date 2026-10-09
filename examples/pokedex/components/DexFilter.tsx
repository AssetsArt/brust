// components/DexFilter.tsx — useState filter/sort; `filterSort` is a module helper so the first paint is a
// precompute job seeded with the initial state and the client recomputes on change (battery e-precompute-state).
import { useState } from 'react'
import { filterSort } from '../lib/filter'
import type { DexCard as Card } from '../lib/types'
import DexCard from './DexCard'
export default function DexFilter(props: { items: Card[] }) {
  const [q, setQ] = useState('')
  const [az, setAz] = useState(false)
  const shown = filterSort(props.items, q, az)
  return (
    <section>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input type="search" placeholder="Search Pokémon…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm sm:max-w-xs dark:border-slate-700 dark:bg-slate-900" />
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setAz(false)} className="rounded-l-xl border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-700">Dex#</button>
          <button type="button" onClick={() => setAz(true)} className="rounded-r-xl border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-700">A–Z</button>
          <span data-testid="count" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold tabular-nums dark:bg-slate-800">{shown.length} / {props.items.length}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {shown.map((c) => <DexCard key={c.id} card={c} />)}
      </div>
    </section>
  )
}
