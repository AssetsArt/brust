// F560: a native component with a job of its own (a class from an imported helper) and state.
import { useState } from 'react'
import { label } from './label'
export default function Bell({ tone }: { tone: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button className={label(tone)} onClick={() => setOpen(!open)}>
      {open ? 'on' : 'off'}
    </button>
  )
}
