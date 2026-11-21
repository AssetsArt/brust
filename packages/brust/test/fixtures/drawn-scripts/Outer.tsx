import { useState } from 'react'
import Inner from './Inner'

export default function Outer() {
  const [on, setOn] = useState(false)
  return (
    <section>
      <button type="button" id="outer" onClick={() => setOn(!on)}>
        outer
      </button>
      <Inner on={on} />
    </section>
  )
}
