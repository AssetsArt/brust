import { useState } from 'react'

// A member computed from the function stays a named refusal (a per-request job cannot name it): React tier, served.
export default function OwnComputedPage() {
  const [on, setOn] = useState(false)
  const toggle = () => setOn(!on)
  const o = { cb: toggle, twice: [toggle, toggle].length }
  return (
    <main>
      <button type="button" data-testid="ownc" onClick={o.cb}>{o.twice}{on ? 'on' : 'off'}</button>
    </main>
  )
}
