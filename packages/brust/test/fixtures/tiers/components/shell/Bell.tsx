import { useState } from 'react'
import { label } from '../../lib/label'

export default function Bell({ tone }: { tone: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button type="button" className={label(tone)} onClick={() => setOpen(!open)}>
      {open ? 'on' : 'off'}
    </button>
  )
}
