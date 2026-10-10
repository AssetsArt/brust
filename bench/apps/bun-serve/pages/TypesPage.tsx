import TypeBadge from '../components/TypeBadge'
export default function TypesPage({ types }: { types: string[] }) {
  return (<><h1>Types</h1><ul>{types.map((t) => <li key={t}><TypeBadge type={t} /></li>)}</ul></>)
}
