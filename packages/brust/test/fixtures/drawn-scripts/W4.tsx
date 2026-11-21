import { useState } from 'react'

export default function W4() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="w4" onClick={() => setN(n + 1)}>
      W4 {n}
    </button>
  )
}
