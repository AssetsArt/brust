import Reviews from './Reviews'
export default function P(props: { items: { id: string }[] }) {
  return (<ul>{props.items.map((it) => (<li key={it.id}><Reviews productId={it.id} /></li>))}</ul>)
}
