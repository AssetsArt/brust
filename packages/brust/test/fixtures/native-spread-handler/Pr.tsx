import { useState } from 'react'

// A native child (state of its own) that spreads its props onto its one element: a handler a caller passes for an event
// the child does not bind itself (mousedown) must run, and the prop read at event time must be the current one.
export default function Pr({ children, ...props }: any) {
  const [on, setOn] = useState(false)
  return (
    <button {...props} aria-pressed={on} onClick={() => setOn(!on)}>
      {children}
    </button>
  )
}
