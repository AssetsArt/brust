import Row from './Row'

export default function Rows({ items }: { items: { id: string; name: string }[] }) {
  return (
    <ul>
      {items.map((it) => (
        <Row key={it.id} item={it} />
      ))}
    </ul>
  )
}
