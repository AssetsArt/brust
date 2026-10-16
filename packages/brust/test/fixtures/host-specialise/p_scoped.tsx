import { useState } from 'react'
import Box from './Box'
import { OShow, PO } from './ProvO'
export default function Page() {
  const [n, setN] = useState(0)
  return (
    <main>
      <button data-testid="f" onClick={() => setN(n + 1)}>f</button>
      <PO>
        <Box>
          <OShow />
          <b>{n}</b>
        </Box>
      </PO>
    </main>
  )
}
