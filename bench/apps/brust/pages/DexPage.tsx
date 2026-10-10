import TypeBadge from '../components/TypeBadge'
import type { DexRow } from '../lib/data'
export default function DexPage({ rows, count }: { rows: DexRow[]; count: number }) {
  return (
    <>
      <h1>Pokédex</h1>
      <p>{count} Pokémon</p>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.badges.map((b) => <TypeBadge key={b.type} type={b.type} label={b.label} color={b.color} />)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
