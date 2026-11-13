import { useState, useTransition } from 'react'

// A React island with per-row props, rendered by the recursive tree: client-only there.
export default function Leaf({ label }: { label: string }) {
  useTransition()
  const [on, setOn] = useState(false)
  return (
    <button type="button" data-testid="leaf" data-on={on ? '1' : '0'} onClick={() => setOn(!on)}>
      {label}
    </button>
  )
}
