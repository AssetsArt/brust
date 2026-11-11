import { useState } from 'react'

// A native leaf (own state, plain props): it mounts at every level of the recursive tree.
export default function Leaf({ label }: { label: string }) {
  const [c, setC] = useState(0)
  return (
    <button type="button" data-leaf={label} onClick={() => setC(c + 1)}>
      {label} {c}
    </button>
  )
}
