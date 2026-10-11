import { useState } from 'react'

export default function Home() {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      actions home {n}
    </button>
  )
}
