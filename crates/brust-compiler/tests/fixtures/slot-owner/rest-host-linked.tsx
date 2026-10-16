import { useState } from 'react'

// F342 + F309: a static child the page links (`on` changes) carries the children through its rest onto its root.
function Label({ on, ...rest }: { on: boolean } & React.ComponentPropsWithoutRef<'span'>) {
  return <span {...rest} data-on={on ? 'yes' : 'no'} />
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
