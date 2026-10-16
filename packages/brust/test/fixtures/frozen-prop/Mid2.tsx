import { useState } from 'react'
import Fwd from './Fwd'
// A native child passing its changing prop through a static forwarder's spread.
export default function Mid2({ on }: { on: boolean }) {
  const [n, setN] = useState(0)
  return (
    <div data-testid="box" data-n={n} onClick={() => setN(n + 1)}>
      box<Fwd data-state={on ? "checked" : "unchecked"} />
    </div>
  )
}
