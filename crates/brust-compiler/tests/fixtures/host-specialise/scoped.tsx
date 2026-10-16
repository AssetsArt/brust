import { useState } from 'react'
import Box from './Box'
import { P, PTrigger } from './Prov'
export default function Page() {
  const [n, setN] = useState(0)
  return (
    <main>
      <button onClick={() => setN(n + 1)}>f</button>
      <P>
        <Box>
          <PTrigger>t</PTrigger>
          <b>{n}</b>
        </Box>
      </P>
    </main>
  )
}
