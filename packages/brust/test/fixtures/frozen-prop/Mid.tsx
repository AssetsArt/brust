import { useState } from 'react'
import Thumb from './Thumb'
// A native child (its own state) that reads a prop its parent changes: in a constant list's rows and as a static child's prop.
export default function Mid({ on }: { on: boolean }) {
  const [n, setN] = useState(0)
  return (
    <div data-testid="box" data-n={n} onClick={() => setN(n + 1)}>
      {[1, 2].map((i) => <b key={i}>{on ? i : -i}</b>)}
      <Thumb on={on} />
    </div>
  )
}
