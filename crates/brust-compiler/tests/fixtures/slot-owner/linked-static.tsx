import { useState } from 'react'

// F309: Label is static, but `on` changes, so the page links it: its root element becomes a host of its own (x-data),
// and the Thumb the page prints inside it would be bound by that host.
function Label({ on, children }: { on: boolean; children?: React.ReactNode }) {
  return <span data-on={on ? 'yes' : 'no'}>{children}</span>
}
function Thumb({ on }: { on: boolean }) {
  return <i data-state={on ? 'checked' : 'unchecked'} />
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button onClick={() => setOn(!on)}>f</button>
      <Label on={on}>
        <Thumb on={on} />
      </Label>
    </main>
  )
}
