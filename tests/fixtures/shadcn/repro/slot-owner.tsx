// F214: the page's own state read (and its handler) inside the slot of a native child. brust keeps this page on React
// (`slot-owner`) instead of binding the slot content to the child's instance.
import { useState } from 'react'

function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div data-testid="box" onClick={() => setN(n + 1)} data-n={n}>
      {children}
    </div>
  )
}

export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <section>
      <button onClick={() => setOn(!on)}>flip</button>
      <Box>
        <p data-testid="p">{on ? 'yes' : 'no'}</p>
      </Box>
    </section>
  )
}
