import TypeBadge from '../../components/TypeBadge'
import { TYPE_NAMES } from '../../lib/data'
export const metadata = { title: 'Types · bench' }
export default function TypesPage() {
  return (<><h1>Types</h1><ul>{TYPE_NAMES.map((t) => <li key={t}><TypeBadge type={t} /></li>)}</ul></>)
}
