// components/HeroSearch.tsx — controlled input + useId; a plain GET form to /pokedex?q= (no SPA navigate).
import { useId, useState } from 'react'
export default function HeroSearch() {
  const id = useId()
  const [q, setQ] = useState('')
  return (
    <form action="/pokedex" method="get" className="mx-auto mt-8 flex w-full max-w-md items-center gap-2 rounded-2xl bg-white/95 p-2 shadow-lg dark:bg-slate-900/90">
      <label htmlFor={id} className="sr-only">Search the Pokédex</label>
      <input id={id} name="q" type="search" placeholder="Search the Pokédex…" value={q} onChange={(e) => setQ(e.target.value)}
        className="min-w-0 flex-1 rounded-xl bg-transparent px-3 py-2 text-sm text-slate-900 dark:text-white" />
      <button type="submit" className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white">Search</button>
    </form>
  )
}
