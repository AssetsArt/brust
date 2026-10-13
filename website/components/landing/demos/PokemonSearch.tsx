import { useDeferredValue, useState } from 'react'

export default function PokemonSearch({ all }: { all: { id: number; no: string; label: string; name: string; sprite: string }[] }) {
  const [q, setQ] = useState('')
  // useDeferredValue keeps the input responsive while the list filters: React only (an island)
  const deferred = useDeferredValue(q)
  const term = deferred.trim().toLowerCase()
  const hits = all.filter((p) => p.name.includes(term)).slice(0, 8)
  return (
    <div className="min-h-60 flex-1 p-5">
      <label className="sr-only" htmlFor="demo-q">
        Search Pokémon
      </label>
      <input id="demo-q" className="w-full rounded-xs border border-rule bg-paper px-3 py-[.55rem] text-ink [font:inherit]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Pokémon, e.g. char" autoComplete="off" />
      <ul className="m-0 mt-[.8rem] grid list-none grid-cols-2 gap-x-[.9rem] gap-y-[.35rem] p-0 text-[14.5px] max-narrow:grid-cols-1">
        {hits.map((p) => (
          <li key={p.id} className="flex min-w-0 items-center gap-[.4rem]">
            <img className="size-10 flex-none [image-rendering:pixelated]" src={p.sprite} alt="" width="40" height="40" />
            <span className="font-mono text-[12px] text-ink-2">{p.no}</span>
            {p.label}
          </li>
        ))}
        {hits.length === 0 ? <li className="col-span-full text-ink-2">No Pokémon match that name.</li> : null}
      </ul>
    </div>
  )
}
