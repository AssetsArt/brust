import { useState } from 'react'
import HydrLog from './HydrLog'

// one instance in the server markup, one that mounts after a click (an x-if clone): React's flag differs between them
export default function HydrIfPage() {
  const [open, setOpen] = useState(false)
  return (
    <main>
      <HydrLog name="first" />
      <button type="button" onClick={() => setOpen(!open)}>
        toggle
      </button>
      {open && <HydrLog name="late" />}
    </main>
  )
}
