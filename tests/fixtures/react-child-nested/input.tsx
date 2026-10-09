import Reviews from './Reviews'

export default function Groups(props: { groups: { id: string; items: { id: string; name: string }[] }[] }) {
  return <div>{props.groups.map((g) => <section key={g.id}>{g.items.map((it) => <Reviews key={it.id} item={it} limit={3} />)}</section>)}</div>
}
