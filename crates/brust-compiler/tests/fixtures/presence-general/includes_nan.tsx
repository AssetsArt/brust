import { useState } from 'react'
export default function P() {
  const [n, setN] = useState(1)
  return <button type="button" onClick={() => setN(Number.NaN)} data-hit={[NaN, 1].includes(n) ? 'y' : 'n'}>{n}</button>
}
