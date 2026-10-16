import { useState } from 'react'

// F309's counterpart: the linked Label prints constant content (no directive of the page in it): kept.
function Label({ on, children }: { on: boolean; children?: React.ReactNode }) {
  return <span data-on={on ? 'yes' : 'no'}>{children}</span>
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button onClick={() => setOn(!on)}>f</button>
      <Label on={on}>
        <b>fixed</b>
      </Label>
    </main>
  )
}
