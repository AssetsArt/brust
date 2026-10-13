import { useState } from 'react'

type Item = { id: string; title: string; href?: string }

export default function Menu({ items }: { items: Item[] }) {
  const [linked, setLinked] = useState(true)
  return (
    <div>
      <button onClick={() => setLinked(!linked)}>toggle</button>
      <ul>
        {items.map((it) =>
          linked && it.href ? (
            <li key={it.id}>
              <a href={it.href}>{it.title}</a>
            </li>
          ) : (
            <li key={it.id}>
              <h4>{it.title}</h4>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}
