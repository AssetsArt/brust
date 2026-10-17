import { useState } from 'react'
import Box from './Box'
// F344 (2): the same host at 20 call sites (content that differs per site).
export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button type="button" data-testid="f" onClick={() => setOn(!on)}>f</button>
      <Box><b data-k="0">{on ? 'a0' : 'b0'}</b></Box>
      <Box><b data-k="1">{on ? 'a1' : 'b1'}</b></Box>
      <Box><b data-k="2">{on ? 'a2' : 'b2'}</b></Box>
      <Box><b data-k="3">{on ? 'a3' : 'b3'}</b></Box>
      <Box><b data-k="4">{on ? 'a4' : 'b4'}</b></Box>
      <Box><b data-k="5">{on ? 'a5' : 'b5'}</b></Box>
      <Box><b data-k="6">{on ? 'a6' : 'b6'}</b></Box>
      <Box><b data-k="7">{on ? 'a7' : 'b7'}</b></Box>
      <Box><b data-k="8">{on ? 'a8' : 'b8'}</b></Box>
      <Box><b data-k="9">{on ? 'a9' : 'b9'}</b></Box>
      <Box><b data-k="10">{on ? 'a10' : 'b10'}</b></Box>
      <Box><b data-k="11">{on ? 'a11' : 'b11'}</b></Box>
      <Box><b data-k="12">{on ? 'a12' : 'b12'}</b></Box>
      <Box><b data-k="13">{on ? 'a13' : 'b13'}</b></Box>
      <Box><b data-k="14">{on ? 'a14' : 'b14'}</b></Box>
      <Box><b data-k="15">{on ? 'a15' : 'b15'}</b></Box>
      <Box><b data-k="16">{on ? 'a16' : 'b16'}</b></Box>
      <Box><b data-k="17">{on ? 'a17' : 'b17'}</b></Box>
      <Box><b data-k="18">{on ? 'a18' : 'b18'}</b></Box>
      <Box><b data-k="19">{on ? 'a19' : 'b19'}</b></Box>
    </main>
  )
}
