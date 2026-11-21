import { useState } from 'react'

export default function W6() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="w6" onClick={() => setN(n + 1)}>
      W6 {n}
    </button>
  )
}
