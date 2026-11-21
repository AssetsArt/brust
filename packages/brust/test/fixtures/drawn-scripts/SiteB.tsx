import { useState } from 'react'
import Box from './Box'

// Case 11: a native parent whose state the Box's children read: the Box host is specialised for this call site.
export default function SiteB() {
  const [on, setOn] = useState(false)
  return (
    <section>
      <button type="button" id="site-B" onClick={() => setOn(!on)}>
        site B
      </button>
      <Box>
        <b id="box-B">{on ? 'B on' : 'B off'}</b>
      </Box>
    </section>
  )
}
