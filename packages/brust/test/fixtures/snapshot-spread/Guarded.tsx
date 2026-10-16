import { useState } from 'react'
import Mid from './Mid'

// A later mount takes the value current then (React): the snapshot is bound at mount (F300), so this page is native.
export default function Guarded() {
  const [on, setOn] = useState(true)
  const [open, setOpen] = useState(false)
  return (
    <main>
      <button type="button" data-testid="toggle" onClick={() => setOn(!on)}>{on ? 'on' : 'off'}</button>
      <button type="button" data-testid="open" onClick={() => setOpen(!open)}>{open ? 'close' : 'open'}</button>
      {open && <Mid id="late" checked={on} />}
    </main>
  )
}
