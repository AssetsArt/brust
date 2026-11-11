import { Dynamic } from '@brust/core'
import Badge from './Badge'

type Item = { ref: string; label: string }

// A stateless host: its rows are server rows, so each may hold a slot.
export default function List({ items }: { items: Item[] }) {
  return (
    <main>
      <Badge />
      <ul>
        {items.map((i) => (
          <li key={i.ref} data-ref={i.ref}>
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
