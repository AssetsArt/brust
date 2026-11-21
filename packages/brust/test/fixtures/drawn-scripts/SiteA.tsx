import { useState } from 'react'
import Box from './Box'

// Case 11: a native parent whose state the Box's children read: the Box host is specialised for this call site.
export default function SiteA() {
  const [on, setOn] = useState(false)
  return (
    <section>
      <button type="button" id="site-A" onClick={() => setOn(!on)}>
        site A
      </button>
      <Box>
        <b id="box-A">{on ? 'A on' : 'A off'}</b>
      </Box>
    </section>
  )
}
