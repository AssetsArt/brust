import { useState } from 'react'
import { Gate } from './Includes'

export default function IncludesPage() {
  const [open, setOpen] = useState(true)
  const [n, setN] = useState(1)
  return (
    <main>
      <button type="button" data-testid="flip" onClick={() => setOpen(!open)}>flip</button>
      <button type="button" data-testid="num" onClick={() => setN(3)}>three</button>
      <Gate open={open} n={n} />
    </main>
  )
}
