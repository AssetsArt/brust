// A caller's own onClick runs first (Radix's composeEventHandlers), then the toggle flips: served and clicked in Chromium.
import { useState } from 'react'
import { Toggle } from '../components/ui/toggle'

export default function Page() {
  const [clicks, setClicks] = useState(0)
  return (
    <div>
      <Toggle aria-label="Toggle counted" onClick={() => setClicks(clicks + 1)}>Counted</Toggle>
      <p id="clicks">{clicks}</p>
    </div>
  )
}
