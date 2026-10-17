import { useState } from 'react'
import Box from './Box'
// F344 (Mellow N1): a host whose own template has a Box whose content reads this host's state (slot-owner -> cloned).
// padding so the page can match this Box element's offset: yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
export default function OHost({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div onClick={() => setN(n + 1)}>
      {children}
      <Box>
        <i>{n}</i>
      </Box>
    </div>
  )
}
