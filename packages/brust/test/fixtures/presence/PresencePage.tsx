import * as React from 'react'
import { Presence } from '@radix-ui/react-presence'
import { Panel } from './Panel'

// F288 phase A: Presence as published, with a function child (collapsible / tabs). `fade` gives the panel an exit
// animation when it closes, so `isPresent` stays true until `animationend` (React's behaviour, from Presence itself).
export default function PresencePage() {
  const [open, setOpen] = React.useState(false)
  return (
    <main>
      <style>{'@keyframes fade { from { opacity: 1 } to { opacity: 0 } } .fade .panel[data-open="n"] { animation: fade 400ms }'}</style>
      <button type="button" data-testid="toggle" onClick={() => setOpen(!open)}>toggle</button>
      <section data-testid="plain">
        <Presence present={open}>{({ present }) => <Panel present={present} open={open}>plain</Panel>}</Presence>
      </section>
      <section className="fade" data-testid="fade">
        <Presence present={open}>{({ present }) => <Panel present={present} open={open}>fade</Panel>}</Presence>
      </section>
    </main>
  )
}
