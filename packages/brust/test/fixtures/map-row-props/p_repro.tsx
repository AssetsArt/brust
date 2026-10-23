import { useState } from 'react'
import Label from './Label'

// The filed B-4 repro: a row child whose prop is built from the row item.
const ROWS = [
  { id: 'x', a: 'one' },
  { id: 'y', a: 'two' },
]
export default function PRepro() {
  const [on, setOn] = useState('x')
  return (
    <main>
      <button type="button" data-testid="go" onClick={() => setOn('y')}>
        y
      </button>
      <p>
        {ROWS.map((r) => (
          <span key={r.id} hidden={on !== r.id}>
            <Label text={{ a: r.a }} />
          </span>
        ))}
      </p>
    </main>
  )
}
