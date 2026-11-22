import { useState } from 'react'
import { viewOf } from './lib/view'

// Interactive, no job of its own: native.
export function Live({ id }: { id: string }) {
  const [n, setN] = useState(0)
  return (
    <button type="button" id={id} onClick={() => setN(viewOf(n) === 'one' ? 2 : 1)}>
      {n}
    </button>
  )
}
