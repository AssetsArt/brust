import { useState } from 'react'
import Motion from './Motion'

// Case 4b/4c: a row's child native component, holding another native component.
export default function Card({ id, label }: { id: string; label: string }) {
  const [n, setN] = useState(0)
  return (
    <div className="card" data-id={id}>
      <button type="button" className="count" onClick={() => setN(n + 1)}>
        {label} {n}
      </button>
      <Motion tag={id} />
    </div>
  )
}
