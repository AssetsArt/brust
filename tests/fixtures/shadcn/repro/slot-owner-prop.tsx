// F214 (Mellow F1): a prop the client changes (Mid is given the page's state) read in the slot of a native child stays
// React (`slot-owner`) instead of being bound to the child's instance.
import { useState } from 'react'

function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div data-testid="box" onClick={() => setN(n + 1)} data-n={n}>
      {children}
    </div>
  )
}

function Mid({ label }: { label: string }) {
  return (
    <Box>
      <p data-testid="p">{label}</p>
    </Box>
  )
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <section>
      <button onClick={() => setOn(!on)}>flip</button>
      <Mid label={on ? 'yes' : 'no'} />
    </section>
  )
}
