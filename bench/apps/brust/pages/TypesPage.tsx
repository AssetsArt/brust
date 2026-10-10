import TypeBadge from '../components/TypeBadge'
import type { Badge } from '../lib/data'
export default function TypesPage({ badges }: { badges: Badge[] }) {
  return (
    <>
      <h1>Types</h1>
      <ul>{badges.map((b) => <li key={b.type}><TypeBadge type={b.type} label={b.label} color={b.color} /></li>)}</ul>
    </>
  )
}
