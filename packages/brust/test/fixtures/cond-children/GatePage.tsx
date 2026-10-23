import { useState } from 'react'
import Gate from './Gate'

export default function GatePage() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button type="button" data-testid="flip" onClick={() => setOn(!on)}>
        f
      </button>
      <Gate>
        <b data-testid="slot">{on ? 'a' : 'b'}</b>
      </Gate>
    </main>
  )
}
