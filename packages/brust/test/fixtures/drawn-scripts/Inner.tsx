import { useState } from 'react'
import W2 from './W2'

// Case 3: a branch over a LIVE prop (`on` comes from the native parent's state).
export default function Inner({ on }: { on: boolean }) {
  const [n, setN] = useState(0)
  return (
    <div>
      <button type="button" id="inner" onClick={() => setN(n + 1)}>
        inner {n}
      </button>
      {on ? <W2 /> : null}
    </div>
  )
}
