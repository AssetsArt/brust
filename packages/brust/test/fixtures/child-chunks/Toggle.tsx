// useState, no job, no useId ⇒ native with a client chunk and no instances[] record.
import { useState } from 'react'
import Deep from './Deep'

export default function Toggle() {
  const [on, setOn] = useState(false)
  return (
    <div>
      <button onClick={() => setOn(!on)}>{on ? 'on' : 'off'}</button>
      <Deep />
    </div>
  )
}
