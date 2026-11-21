import { useState } from 'react'

export default function W2() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="w2" onClick={() => setN(n + 1)}>
      W2 {n}
    </button>
  )
}
