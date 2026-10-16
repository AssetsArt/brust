import { useState } from 'react'
import Mid from './Mid'

// A later mount takes the value current then (React): brust cannot re-apply a spread key at mount yet (F300), so
// this page is refused (snapshot-remount) and renders with React.
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
