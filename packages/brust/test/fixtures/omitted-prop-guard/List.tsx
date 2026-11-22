import { Section } from './Section'

type Item = { id: string }

export function List({ items }: { items: Item[] }) {
  return (
    <div>
      {items.map((i) => (
        <Section key={i.id} id={i.id} />
      ))}
    </div>
  )
}
