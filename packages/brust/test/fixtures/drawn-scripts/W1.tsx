import { useState } from 'react'

export default function W1() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="w1" onClick={() => setN(n + 1)}>
      W1 {n}
    </button>
  )
}
