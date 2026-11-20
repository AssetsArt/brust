// F562: a state-driven list whose callback destructures its item and has a block body: a row const read by the markup
// and by a click handler, and an early `return null`. The page is native (no React on the client).
import { useState } from 'react'

type Item = { id: string; name: string; price: number }

export default function Rows() {
  const [items, setItems] = useState<Item[]>([
    { id: 'a', name: 'Alpha', price: 3 },
    { id: 'b', name: 'Beta', price: 10 },
    { id: 'c', name: 'Gamma', price: 7 },
  ])
  const [picked, setPicked] = useState('none')
  return (
    <div>
      <p data-testid="picked">{picked}</p>
      <button data-testid="reverse" onClick={() => setItems([...items].reverse())}>
        reverse
      </button>
      <button data-testid="bump" onClick={() => setItems(items.map((it) => ({ ...it, price: it.price + 5 })))}>
        bump
      </button>
      <ul data-testid="rows">
        {items.map(({ id, name, price }, i) => {
          const label = `${name} (${price})`
          if (price > 12) return null
          return (
            <li
              key={id}
              data-testid={`row-${id}`}
              title={label}
              onClick={() => {
                setPicked(`${label} #${i}`)
              }}
            >
              {label}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
