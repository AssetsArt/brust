import { useState } from 'react'
import Mid from './Mid'

// Case 5: a native host inside a native host inside a hidden copy.
export default function Nest() {
  const [show, setShow] = useState(false)
  return (
    <section>
      <button type="button" id="nest" onClick={() => setShow(!show)}>
        nest
      </button>
      {show ? <Mid /> : null}
    </section>
  )
}
