import { useState } from 'react'
import Initial from './Initial'
import Mid from './Mid'

// F277 (Mellow F1): a child that mounts after first paint reads the CURRENT prop for its fixed cell, directly under a
// condition and one level down (a component under the condition whose own state starts from the prop).
export default function Remount() {
  const [label, setLabel] = useState('a')
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" data-testid="label" onClick={() => setLabel(`${label}x`)}>
        {label}
      </button>
      <button type="button" data-testid="open" onClick={() => setOpen(!open)}>
        open
      </button>
      <Initial label={label} testid="always" />
      {open && <Initial label={label} testid="cond" />}
      {open && <Mid init={label} />}
    </div>
  )
}
