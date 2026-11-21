import { useState } from 'react'

export default function Always() {
  const [n, setN] = useState(0)
  return (
    <button type="button" id="always" onClick={() => setN(n + 1)}>
      Always {n}
    </button>
  )
}
