import * as React from 'react'
import { Presence } from '@radix-ui/react-presence'
import { Panel } from './Panel'

// F288 phase B: Presence as published with an ELEMENT child (checkbox / radio indicators): the child is mounted only
// while present. `fade` gives it an exit animation, so it stays in the document until `animationend`.
export default function ElementPage() {
  const [open, setOpen] = React.useState(false)
  return (
    <main>
      <style>{'@keyframes fade { from { opacity: 1 } to { opacity: 0 } } .fade .panel[data-open="n"] { animation: fade 400ms }'}</style>
      <button type="button" data-testid="toggle" onClick={() => setOpen(!open)}>toggle</button>
      <section data-testid="plain">
        <Presence present={open}>
          <Panel present={open} open={open}>plain</Panel>
        </Presence>
      </section>
      <section className="fade" data-testid="fade">
        <Presence present={open}>
          <Panel present={open} open={open}>fade</Panel>
        </Presence>
      </section>
    </main>
  )
}
