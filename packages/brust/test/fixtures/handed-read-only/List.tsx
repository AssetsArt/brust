import { Section } from './Section'

type Item = { type: string; id: string }

export function List({ items }: { items: Item[] }) {
  return (
    <div>
      {items.map((i) => (i.type === 'list' ? <Section key={i.id} id={i.id} /> : <p key={i.id}>{i.id}</p>))}
    </div>
  )
}
