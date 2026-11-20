// Bell with a function prop it calls at render.
import { useState } from 'react'
import { label } from '../per-instance-jobs/label'
export default function BellFn({ tone, format }: { tone: string; format: (s: string) => string }) {
  const [open, setOpen] = useState(false)
  return (
    <button className={label(tone)} onClick={() => setOpen(!open)}>
      {format(open ? 'on' : 'off')}
    </button>
  )
}
