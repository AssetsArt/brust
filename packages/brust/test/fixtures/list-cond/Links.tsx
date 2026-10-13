// L6 R6.1: a keyed arm next to a null arm. The key is guarded (`it.link && <li key={it.link.id}>`),
// so a row whose link is null must not throw on the client.
import { useState } from 'react'

type Link = { id: string; href: string }
type Item = { id: string; title: string; link: Link | null }

export default function Links() {
  const [items, setItems] = useState<Item[]>([
    { id: 'a', title: 'Alpha', link: null },
    { id: 'b', title: 'Beta', link: { id: 'lb', href: '/b' } },
    { id: 'c', title: 'Gamma', link: null },
  ])
  return (
    <div>
      <button data-testid="reorder" onClick={() => setItems([...items].reverse())}>
        reorder
      </button>
      <button
        data-testid="toggle"
        onClick={() =>
          setItems(items.map((it) => (it.id === 'a' ? { ...it, link: it.link ? null : { id: 'la', href: '/a' } } : it)))
        }
      >
        toggle
      </button>
      <ul>{items.map((it) => it.link && <li key={it.link.id}><a href={it.link.href}>{it.title}</a></li>)}</ul>
    </div>
  )
}
