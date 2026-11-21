import { useState } from 'react'

export default function Lw() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="lw" onClick={() => setN(n + 1)}>
      layout {n}
    </button>
  )
}
