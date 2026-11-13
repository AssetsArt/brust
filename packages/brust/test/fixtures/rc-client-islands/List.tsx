import { Dynamic } from '@brust/core'

type Item = { key: string; label: string }

export default function List({ items }: { items: Item[] }) {
  return (
    <main>
      <ul>
        {items.map((i) => (
          <li key={i.key} data-row={i.key}>
            <Dynamic component="promo" props={{ label: i.label }} />
          </li>
        ))}
      </ul>
    </main>
  )
}
