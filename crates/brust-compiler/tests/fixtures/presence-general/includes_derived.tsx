import { useState } from 'react'
export default function P() {
  const [n, setN] = useState(1)
  const twice = n * 2
  return <button type="button" onClick={() => setN(n + 1)} data-hit={[2, 4].includes(twice) ? 'y' : 'n'}>{n}</button>
}
