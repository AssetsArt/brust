// Demo, react tier: an in-repo custom hook (useDebounced). Custom hooks are not compiled natively, so this component
// becomes a React island: server-rendered with React, hydrated with one React chunk.
import { useEffect, useState } from 'react'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export default function PokemonSearch({ all }: { all: { id: number; no: string; name: string; sprite: string }[] }) {
  const [q, setQ] = useState('')
  const term = useDebounced(q.trim().toLowerCase(), 150)
  const hits = all.filter((p) => p.name.toLowerCase().includes(term) || p.no.includes(term))
  return (
    <div>
      <label className="sr" htmlFor="demo-q">
        Search Pokémon
      </label>
      <input id="demo-q" className="demo-in" placeholder="Search Pokémon, e.g. char" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="demo-list">
        {hits.length === 0 ? <li className="empty">No Pokémon match “{term}”.</li> : null}
        {hits.map((p) => (
          <li key={p.id}>
            <img src={p.sprite} alt="" width={40} height={40} loading="lazy" />
            <span className="no">{p.no}</span>
            {p.name}
          </li>
        ))}
      </ul>
    </div>
  )
}
