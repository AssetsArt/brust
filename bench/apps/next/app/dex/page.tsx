import TypeBadge from '../../components/TypeBadge'
import { loadDex } from '../../lib/data'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Pokédex · bench' }
export default function DexPage() {
  const rows = loadDex()
  return (
    <>
      <h1>Pokédex</h1>
      <p>{rows.length} Pokémon</p>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
        <tbody>{rows.map((p) => <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.types.map((t) => <TypeBadge key={t} type={t} />)}</td></tr>)}</tbody>
      </table>
    </>
  )
}
