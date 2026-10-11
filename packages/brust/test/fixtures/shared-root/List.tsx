// Ledger F75: a stateless route ROOT on /a (fixed props: F70 drops its row links) and a LINKED
// child of Board on /b (props change on the client: rows are x-for rows driven by _l1/_k1/_p1).
import Row from './Row'

export default function List(props: { items: { id: string; name: string }[] }) {
  return (
    <ul>
      {props.items.map((it) => (
        <Row key={it.id} name={it.name} />
      ))}
    </ul>
  )
}
