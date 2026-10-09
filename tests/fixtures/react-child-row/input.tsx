import Reviews from './Reviews'

export default function List(props: { items: { id: string; name: string }[] }) {
  return <ul>{props.items.map((it) => <li key={it.id}>{it.name}<Reviews item={it} limit={3} /></li>)}</ul>
}
