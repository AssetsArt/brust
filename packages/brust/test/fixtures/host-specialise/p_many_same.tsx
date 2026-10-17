import { useState } from 'react'
import Box from './Box'
// F344 (2): the same host at 20 call sites (identical content).
export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button type="button" data-testid="f" onClick={() => setOn(!on)}>f</button>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
      <Box><b>{on ? 'a' : 'b'}</b></Box>
    </main>
  )
}
