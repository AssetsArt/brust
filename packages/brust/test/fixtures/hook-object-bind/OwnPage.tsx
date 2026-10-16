import { useState } from 'react'

// F331: the component's own functions held in an object are read where `o.cb` is read (was a refusal that rendered React).
export default function OwnPage() {
  const [n, setN] = useState(0)
  const inc = () => setN(n + 1)
  function reset() { setN(0) }
  const o = { cb: inc, off: reset, label: 'go' }
  return (
    <main>
      <button type="button" data-testid="own-a" onClick={o.cb}>{o.label}{n}</button>
      <button type="button" data-testid="own-b" onClick={o.cb}>again{n}</button>
      <button type="button" data-testid="own-r" onClick={o.off}>reset</button>
    </main>
  )
}
