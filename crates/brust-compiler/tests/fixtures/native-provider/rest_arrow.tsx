import { useState } from 'react'

// a function of the component with a rest parameter: it keeps the `...`
export default function Count() {
  const [n, setN] = useState(0)
  const count = (...xs: number[]) => xs.length
  return (
    <button type="button" onClick={() => setN(n + count(1, 2, 3))}>
      {n}
    </button>
  )
}
