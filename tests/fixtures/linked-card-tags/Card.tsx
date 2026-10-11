import Badge from './Badge'
export default function Card(props: { name: string; tags: string[] }) {
  return <section><span>{props.name}</span>{props.tags.map((t) => <Badge key={t} label={t} />)}</section>
}
