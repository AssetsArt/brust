import { useState } from 'react'
import Box from './Box'
// S6: the clone mounts late, under the page's condition, after the page's state changed: it starts from the current value.
export default function Page() {
  const [on, setOn] = useState(false)
  const [show, setShow] = useState(false)
  return (
    <main>
      <button data-testid="f" onClick={() => setOn(!on)}>f</button>
      <button data-testid="g" onClick={() => setShow(!show)}>g</button>
      {show && <Box><b>{on ? 'a' : 'b'}</b></Box>}
    </main>
  )
}
