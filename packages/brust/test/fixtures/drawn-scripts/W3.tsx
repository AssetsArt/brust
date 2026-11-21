import { useState } from 'react'

export default function W3() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="w3" onClick={() => setN(n + 1)}>
      W3 {n}
    </button>
  )
}
