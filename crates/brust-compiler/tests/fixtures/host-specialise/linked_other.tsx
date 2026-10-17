import { useState } from 'react'
import { Indicator, Root } from './ProvV'
// F348: the clone of Root is linked for ANOTHER reason (its `max` is the page's state, which changes), while `value` is a
// constant the call site never changes: `value` is still pinned (fixed) in the clone, `max` is not.
export default function Page() {
  const [m, setM] = useState(100)
  return (
    <main>
      <button onClick={() => setM(m + 1)}>f</button>
      <Root value={50} max={m}>
        <Indicator />
      </Root>
    </main>
  )
}
