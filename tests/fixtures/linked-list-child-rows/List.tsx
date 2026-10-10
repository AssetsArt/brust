import Badge from './Badge'
export default function List(props: { rows: { id: string; name: string }[] }) {
  return <ul>{props.rows.map((r) => <li key={r.id}><Badge label={r.name} /></li>)}</ul>
}
