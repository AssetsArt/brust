import { useState } from 'react'

export default function W5() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="w5" onClick={() => setN(n + 1)}>
      W5 {n}
    </button>
  )
}
