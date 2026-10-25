import { useState } from 'react'
// A native child that prints its children only when open (its own x-if around the slot).
export default function Gate({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button data-testid="box" onClick={() => setOpen(!open)}>t</button>
      {open && children}
    </div>
  )
}
