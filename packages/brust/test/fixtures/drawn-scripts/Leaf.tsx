import { useState } from 'react'

export default function Leaf() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="leaf" onClick={() => setN(n + 1)}>
      leaf {n}
    </button>
  )
}
