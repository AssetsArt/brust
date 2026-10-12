import { useState } from 'react'
import { useDebounced } from './useDebounced'

export default function PokemonSearch({ all }: { all: { id: number; no: string; label: string; name: string; sprite: string }[] }) {
  const [q, setQ] = useState('')
  const debounced = useDebounced(q, 150)
  const term = debounced.trim().toLowerCase()
  const hits = all.filter((p) => p.name.includes(term)).slice(0, 8)
  return (
    <div className="vp">
      <label className="sr" htmlFor="demo-q">
        Search Pokémon
      </label>
      <input id="demo-q" className="demo-in" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Pokémon, e.g. char" autoComplete="off" />
      <ul className="demo-list">
        {hits.map((p) => (
          <li key={p.id}>
            <img src={p.sprite} alt="" width="40" height="40" />
            <span className="no">{p.no}</span>
            {p.label}
          </li>
        ))}
        {hits.length === 0 ? <li className="empty">No Pokémon match that name.</li> : null}
      </ul>
    </div>
  )
}
