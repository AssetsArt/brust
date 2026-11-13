import { Dynamic } from '@brust/core'

type Item = { key: string; ref: string; label: string }

// Server rows, each holding a slot: three rows of one island artifact with different props.
export default function List({ items }: { items: Item[] }) {
  return (
    <main>
      <ul>
        {items.map((i) => (
          <li key={i.key} data-row={i.key}>
            <Dynamic component={i.ref} props={{ label: i.label }} />
          </li>
        ))}
      </ul>
      <a href="/other" data-testid="to-other">
        other
      </a>
    </main>
  )
}
