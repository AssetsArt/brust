import { useState } from 'react'
import Deep from './Deep'

// A row child whose prop is a nested object built from the row item.
const ROWS = [
  { id: 'x', t: 'one', g: 'p' },
  { id: 'y', t: 'two', g: 'q' },
]
export default function PNested() {
  const [on, setOn] = useState('x')
  return (
    <main>
      <button type="button" data-testid="go" onClick={() => setOn('y')}>
        y
      </button>
      <p>
        {ROWS.map((r) => (
          <span key={r.id} hidden={on !== r.id}>
            <Deep cfg={{ label: { text: r.t }, tags: [r.g, r.id] }} />
          </span>
        ))}
      </p>
    </main>
  )
}
