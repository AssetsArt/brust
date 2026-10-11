import { useState } from 'react'

export default function PlainPage() {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      plain {n}
    </button>
  )
}
