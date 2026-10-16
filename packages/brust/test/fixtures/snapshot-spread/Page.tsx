import { useState } from 'react'
import Bubble from './Bubble'
import Mid from './Mid'

// Every instance mounts with the page and never again: each keeps the value `on` had at first render.
export default function Page() {
  const [on, setOn] = useState(true)
  return (
    <main>
      <button type="button" data-testid="toggle" onClick={() => setOn(!on)}>{on ? 'on' : 'off'}</button>
      <Bubble id="always" checked={on} />
      <Mid id="mid" checked={on} />
    </main>
  )
}
