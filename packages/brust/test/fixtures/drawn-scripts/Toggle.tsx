import { useState } from 'react'
import W1 from './W1'

// Case 2: a branch over this component's state, hidden at first paint.
export default function Toggle() {
  const [show, setShow] = useState(false)
  return (
    <section>
      <button type="button" id="tg" onClick={() => setShow(!show)}>
        toggle
      </button>
      {show ? <W1 /> : null}
    </section>
  )
}
