import { useState } from 'react'
import Box from './Box'
import OHost from './OHost'
// F344 (Mellow N1): the page's Box element below sits at the same byte offset as OHost's own Box element; inside
// OHost's clone both are call sites of one template. Padding: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button type="button" onClick={() => setOn(!on)}>f</button>
      <OHost>
        <Box>
          <b>{on ? 'a' : 'b'}</b>
        </Box>
      </OHost>
    </main>
  )
}
