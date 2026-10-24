import { useState } from 'react'

// The battery's c-slot-owner-gate shape: a native child that prints its children only when open, the page's own state
// in the slot.
export default function Gate({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div data-testid="gate">
      <button type="button" data-testid="gate-toggle" onClick={() => setOpen(!open)}>
        t
      </button>
      {open && children}
    </div>
  )
}
